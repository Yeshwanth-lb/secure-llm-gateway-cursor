// ===== PROXY PIPELINE (Phase B2) ============================================
// Request lifecycle (newplan §6): inbound scrub -> forward -> outbound scrub ->
// finalize a LogEntry. JSON bodies deep-walked; SSE responses streamed through
// the StreamRedactor; everything else scrubbed as raw text. Fail-safe: a request
// whose body cannot be scrubbed is never forwarded raw (redactText never throws).
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.ts";
import type { Provider, RouteResult, LogEntry, AnalyzerLog } from "./contracts.ts";
import { buildForwardHeaders } from "./routing.ts";
import { redactJson, redactText } from "./redaction.ts";
import { StreamRedactor } from "./stream-redactor.ts";
import { trafficLog } from "./traffic-log.ts";
import { extractUserPrompt, extractAssistantOutput } from "./clean-view.ts";
import { sendJson } from "./http-utils.ts";
import { extractModel, isModelBlocked } from "./model-policy.ts";
import { analyze, type ClassifyFn } from "./prompt-analyzer.ts";
import { classifyViaAnthropic } from "./prompt-classifier.ts";
import { buildGuidance, hasBlockCategory, templateIdsFor } from "./guidance.ts";
import { securityLog, type SecurityLogEntry } from "./security-log.ts";
import {
  openaiToAnthropicRequest,
  anthropicToOpenAIResponse,
  AnthropicToOpenAISSE,
  shouldTranslate,
} from "./openai-anthropic-shim.ts";

/** Cap a snapshot string; cap <= 0 means unlimited. */
const snap = (s: string, cap: number): string => (cap > 0 ? s.slice(0, cap) : s);

/** Credential-bearing query params that must never reach a traffic-log path (§5). */
const CRED_QUERY_KEYS = new Set(["key", "api_key", "apikey", "access_token", "token"]);

/** Redact secret query params in a path before it is stored in a LogEntry. */
function sanitizePath(rawPath: string): string {
  const qi = rawPath.indexOf("?");
  if (qi === -1) return rawPath;
  const base = rawPath.slice(0, qi);
  const params = new URLSearchParams(rawPath.slice(qi + 1));
  let touched = false;
  for (const k of [...params.keys()]) {
    if (CRED_QUERY_KEYS.has(k.toLowerCase())) {
      params.set(k, "[REDACTED]");
      touched = true;
    }
  }
  if (!touched) return rawPath;
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

const isJson = (ct?: string): boolean => !!ct && /application\/json/i.test(ct);
const isSse = (ct?: string): boolean => !!ct && /text\/event-stream/i.test(ct);
const hasKeys = (m: Record<string, number>): boolean => Object.keys(m).length > 0;

const isEmptyText = (b: unknown): boolean =>
  !!b && typeof b === "object" && (b as any).type === "text" &&
  (typeof (b as any).text !== "string" || (b as any).text.trim() === "");

/**
 * Repair empty text content blocks that some clients (e.g. Claude Code replaying
 * a mangled assistant turn) leave in `messages[]`/`system[]`. Anthropic rejects
 * them with `400 text content blocks must be non-empty`. Drop empties; if that
 * would empty a content array, keep one minimal non-empty block. Mutates `obj`.
 */
function sanitizeEmptyBlocks(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, any>;
  let changed = false;
  const fix = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const content = item && typeof item === "object" ? (item as any).content : undefined;
      if (!Array.isArray(content)) continue;
      const kept = content.filter((b: unknown) => !isEmptyText(b));
      if (kept.length !== content.length) {
        changed = true;
        (item as any).content = kept.length ? kept : [{ type: "text", text: " " }];
      }
    }
  };
  fix(o.messages);
  if (Array.isArray(o.system)) {
    const kept = o.system.filter((b: unknown) => !isEmptyText(b));
    if (kept.length !== o.system.length) {
      changed = true;
      o.system = kept.length ? kept : [{ type: "text", text: " " }];
    }
  }
  return changed;
}

/**
 * Append a guidance block to the request's SYSTEM channel — NEVER the user's
 * message text (checkpoint.md §6). Existing system entries are preserved in order
 * (no-clobber). Best-effort per provider; on any parse failure the body is
 * returned UNCHANGED (fail open — a guidance layer must never drop a request).
 */
function injectGuidance(bodyText: string, provider: Provider, guidance: string): string {
  if (!guidance) return bodyText;
  let obj: any;
  try {
    obj = JSON.parse(bodyText);
  } catch {
    return bodyText; // non-JSON body -> nothing to inject into, leave as-is
  }
  if (!obj || typeof obj !== "object") return bodyText;
  const block = { type: "text", text: guidance };
  try {
    if (provider === "anthropic") {
      if (Array.isArray(obj.system)) obj.system = [...obj.system, block];
      else if (typeof obj.system === "string") obj.system = `${obj.system}\n\n${guidance}`;
      else obj.system = [block];
    } else if (provider === "gemini") {
      const si = obj.systemInstruction ?? obj.system_instruction ?? {};
      const parts = Array.isArray(si.parts) ? [...si.parts, { text: guidance }] : [{ text: guidance }];
      obj.systemInstruction = { ...si, parts };
      delete obj.system_instruction;
    } else {
      // openai-compatible: a leading system message. Append to an existing one,
      // else prepend a new system message ahead of the conversation.
      const msgs = Array.isArray(obj.messages) ? obj.messages : [];
      if (msgs[0] && msgs[0].role === "system" && typeof msgs[0].content === "string") {
        msgs[0] = { ...msgs[0], content: `${msgs[0].content}\n\n${guidance}` };
      } else {
        msgs.unshift({ role: "system", content: guidance });
      }
      obj.messages = msgs;
    }
    return JSON.stringify(obj);
  } catch {
    return bodyText; // any failure -> forward the original, unmodified
  }
}

/** Scrub a body toward the given direction; JSON deep-walked, else raw text.
 *  Inbound requests are also sanitized of empty text blocks before forwarding. */
function scrub(
  raw: string,
  contentType: string | undefined,
  dir: "inbound" | "outbound",
): { text: string; matched: Record<string, number> } {
  if (raw === "") return { text: "", matched: {} };
  if (isJson(contentType)) {
    try {
      const parsed = JSON.parse(raw);
      if (dir === "inbound") sanitizeEmptyBlocks(parsed);
      const { value, matched } = redactJson(parsed, dir);
      return { text: JSON.stringify(value), matched };
    } catch {
      // malformed JSON degrades to raw-text scrub (§7) — never forward raw.
    }
  }
  const r = redactText(raw, dir);
  return { text: r.text, matched: r.matched };
}

/** Copy upstream response headers minus hop-by-hop; length/encoding recomputed. */
function respHeaders(src: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  const drop = new Set([
    "connection",
    "transfer-encoding",
    "content-length",
    "content-encoding",
    "keep-alive",
  ]);
  for (const [k, v] of Object.entries(src)) {
    const lk = k.toLowerCase();
    if (drop.has(lk) || v === undefined) continue;
    out[lk] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function forward(
  route: RouteResult,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  timeoutMs: number,
): { req: http.ClientRequest; response: Promise<IncomingMessage> } {
  const target = new URL(route.upstreamBase + route.forwardPath);
  const mod = target.protocol === "https:" ? https : http;
  const opts: https.RequestOptions = {
    method,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    headers: { ...headers, "content-length": String(body.length) },
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
  };
  let r!: http.ClientRequest;
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    r = mod.request(opts, resolve);
    r.on("error", reject);
    // Connect/read timeout: abort so no request hangs forever (§5).
    r.on("timeout", () => r.destroy(new Error(`upstream timeout after ${timeoutMs}ms`)));
    if (body.length) r.write(body);
    r.end();
  });
  return { req: r, response };
}

export async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bodyBuf: Buffer,
  route: RouteResult,
  config: GatewayConfig,
): Promise<void> {
  const started = Date.now();
  const method = req.method ?? "GET";
  const path = sanitizePath(req.url ?? "/"); // strip secret query params before logging
  let reqCt = req.headers["content-type"];
  const nowSeconds = Math.floor(started / 1000);
  const chunkId = `chatcmpl-${randomUUID()}`;

  // --- routing decision: translate by MODEL NAME on a shared endpoint --------
  // Cursor exposes ONE global "Override OpenAI Base URL", so GPT vs Claude cannot
  // be split by path — every model call from a Cursor install lands on the same
  // endpoint. We branch on the request's model id instead: ids that select Claude
  // (a "claude-*" id, or a configured alias like "claude-via-gateway") are
  // translated to the Anthropic Messages API and sent to Claude; every other
  // model passes through to the OpenAI-compatible upstream unchanged. Only
  // OpenAI-shaped routes are eligible.
  const rawModel = extractModel(route.provider, route.forwardPath, bodyBuf.toString("utf8"));
  const translating =
    route.provider === "openai" && shouldTranslate(rawModel, config.cursorTranslateModels);
  // Where the (possibly translated) request is forwarded + how it is logged.
  const fwdRoute: RouteResult = translating
    ? {
        provider: "anthropic",
        upstreamBase: config.upstreams.anthropic.replace(/\/+$/, ""),
        forwardPath: "/v1/messages",
      }
    : route;
  const logProvider: Provider = fwdRoute.provider;

  let bodyText = bodyBuf.toString("utf8");
  let model: string | undefined = rawModel;
  // The exact model id the client asked for (e.g. the Cursor alias
  // "claude-via-gateway"). OpenAI-compatible clients validate a custom model by
  // matching the `model` field they get back against what they sent, so the
  // translate-path OpenAI response must echo THIS id — not the resolved Claude
  // id. `model` still holds the resolved id for policy checks, forwarding, logs.
  const clientModel = rawModel;

  // Prompt-guard (Checkpoint 1) decision metadata for this request, filled in
  // below when the analyzer runs. PII-safe (no raw prompt / no guidance body) —
  // those go to the admin-gated securityLog. Captured here so recordEntry can
  // stamp it onto whichever LogEntry the request ultimately produces.
  let analyzerMeta: AnalyzerLog | undefined;
  // Held reference to this request's security-log entry (if the guard acted), so
  // recordEntry can back-fill the model's response once the turn completes.
  let secEntry: SecurityLogEntry | undefined;

  // Log-entry builder (takes the inbound scrub result explicitly so it can be
  // called from the translate preamble, before the main inbound scrub runs).
  const recordEntry = (
    status: number,
    streaming: boolean,
    respText: string,
    inb: { text: string; matched: Record<string, number> },
    outMatched: Record<string, number>,
    blocked = false,
  ): void => {
    const entry: LogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      provider: logProvider,
      model,
      blocked,
      method,
      path,
      status,
      streaming,
      durationMs: Date.now() - started,
      charCount: {
        request: inb.text.length,
        response: respText.length,
        total: inb.text.length + respText.length,
      },
      payloadSnapshot: {
        request: snap(inb.text, config.snapshotChars),
        response: snap(respText, config.snapshotChars),
      },
      piiDetected: hasKeys(inb.matched) || hasKeys(outMatched),
      matchedRules: { inbound: inb.matched, outbound: outMatched },
      // Distill from the FULL redacted body now, while we still have it — the
      // stored snapshot is truncated (SNAPSHOT_CHARS) and a huge Claude Code
      // request would otherwise lose the user prompt sitting past the cut.
      clean: {
        userPrompt: extractUserPrompt(inb.text),
        assistantOutput: extractAssistantOutput(logProvider, respText),
      },
      analyzer: analyzerMeta,
    };
    // Back-fill the model's (redacted) reply onto the security-log record so a
    // reviewer sees prompt + guidance + output together. Store the DISTILLED
    // assistant text (not the raw JSON/SSE envelope) so the dashboard shows clean
    // code, not a wire payload. Raw PII never persists here either.
    if (secEntry) {
      const clean = extractAssistantOutput(logProvider, respText);
      secEntry.response = snap(clean, config.snapshotChars);
    }
    trafficLog.push(entry);
  };

  // --- translate preamble: OpenAI request -> Anthropic Messages --------------
  // Runs BEFORE the inbound scrub (scrub then sees the translated body) and
  // BEFORE the model-policy check (so the check tests the RESOLVED Claude model,
  // not the alias — a blocked Claude model must not be reachable under an alias;
  // see CURSOR_INTEGRATION_PLAN §5.1).
  if (translating) {
    let openaiObj: unknown;
    try {
      openaiObj = JSON.parse(bodyText);
    } catch {
      openaiObj = null;
    }
    try {
      const t = openaiToAnthropicRequest(openaiObj, {
        modelMap: config.cursorModelMap,
        defaultModel: config.cursorDefaultModel,
        maxTokens: config.cursorMaxTokens,
      });
      model = t.model;
      bodyText = JSON.stringify(t.body);
      reqCt = "application/json";
    } catch (e) {
      // Structurally invalid OpenAI request -> clean 400 in OpenAI error shape,
      // logged, nothing forwarded.
      const inb = scrub(bodyText, "application/json", "inbound");
      recordEntry(400, false, "", inb, {}, false);
      sendJson(res, 400, {
        error: { message: `Invalid request: ${(e as Error).message}`, type: "invalid_request_error" },
      });
      return;
    }
  }

  // --- prompt guard (Checkpoint 1): analyze -> steer via system channel ------
  // Runs AFTER model resolution / translate preamble and BEFORE the inbound
  // scrub, so guidance is injected into the SAME body that gets scrubbed +
  // forwarded. Analyzer FAILS OPEN (never throws) — a miss means no guidance,
  // never a dropped request. Never touches the user's message text. Anthropic-
  // only Tier-2 in v1 (the Claude Code wire); other providers get Tier-1 only.
  if (config.promptGuardEnabled) {
    const rawPrompt = extractUserPrompt(bodyText);
    // extractUserPrompt returns a "(…)" placeholder when there is no real user
    // text (e.g. a non-chat body) — treat those as nothing to analyze.
    const analyzable = rawPrompt && !rawPrompt.startsWith("(");
    if (analyzable) {
      // Tier-2 reuses the request's OWN upstream + auth (no new key). v1: only
      // the native Anthropic path (Claude Code). A test-installed module
      // classifier, if any, overrides this inside analyze().
      let classify: ClassifyFn | undefined;
      if (config.promptGuardTier2 && fwdRoute.provider === "anthropic") {
        const gh: Record<string, string> = {};
        const pick = (k: string): string | undefined => {
          const v = req.headers[k];
          return Array.isArray(v) ? v[0] : v;
        };
        if (translating) {
          const bearer = (pick("authorization") ?? "").replace(/^Bearer\s+/i, "");
          const key = config.anthropicApiKey || bearer;
          if (key) gh["x-api-key"] = key;
        } else {
          const xk = pick("x-api-key");
          if (xk) gh["x-api-key"] = xk;
          const auth = pick("authorization");
          if (auth) gh["authorization"] = auth;
        }
        gh["anthropic-version"] = pick("anthropic-version") ?? config.anthropicVersion;
        classify = classifyViaAnthropic({
          upstreamBase: fwdRoute.upstreamBase,
          headers: gh,
          model: config.promptGuardModel,
          timeoutMs: config.promptGuardTimeoutMs,
        });
      }
      const verdict = await analyze(rawPrompt, {
        tier2Enabled: config.promptGuardTier2,
        classify,
        timeoutMs: config.promptGuardTimeoutMs,
      });
      if (verdict.verdict !== "allow") {
        const guidance = buildGuidance(verdict.categories);
        const isBlock = verdict.verdict === "block" && hasBlockCategory(verdict.categories);
        analyzerMeta = {
          verdict: verdict.verdict,
          categories: verdict.categories,
          confidence: verdict.confidence,
          tier: verdict.tier,
          guidanceInjected: !isBlock && guidance !== "",
          templateIds: templateIdsFor(verdict.categories),
          latencyMs: verdict.latencyMs,
          surface: "claude-code",
        };
        // RAW prompt + exact guidance -> admin-gated security log only. Held by
        // reference so recordEntry can add the model's response after the turn.
        secEntry = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          surface: "claude-code",
          verdict: verdict.verdict,
          categories: verdict.categories,
          confidence: verdict.confidence,
          tier: verdict.tier,
          rawPrompt,
          guidance: isBlock ? "" : guidance,
          provider: fwdRoute.provider,
          model,
        };
        securityLog.push(secEntry);
        if (isBlock) {
          // Severe category (reserved set) — short-circuit with a refusal; nothing
          // forwarded. v1 keeps this dormant (no active block category).
          const inb = scrub(bodyText, reqCt, "inbound");
          recordEntry(403, false, "", inb, {}, true);
          sendJson(res, 403, {
            error: "Request blocked by prompt-guard policy",
            categories: verdict.categories,
          });
          return;
        }
        // Steer: inject guidance into the system channel of the body to forward.
        bodyText = injectGuidance(bodyText, fwdRoute.provider, guidance);
      } else {
        analyzerMeta = {
          verdict: "allow",
          categories: [],
          confidence: verdict.confidence,
          tier: verdict.tier,
          guidanceInjected: false,
          templateIds: [],
          latencyMs: verdict.latencyMs,
          surface: "claude-code",
        };
      }
    }
  }

  // --- inbound scrub (before any byte leaves the machine) --------------------
  const inbound = scrub(bodyText, reqCt, "inbound");
  const cleanBody = Buffer.from(inbound.text, "utf8");
  const fwdHeaders = buildForwardHeaders(req, fwdRoute);
  if (translating) {
    // Auth swap: drop the client's OpenAI bearer; present server-side Anthropic
    // auth so the real key never touches the client. Fall back to the incoming
    // bearer token if no server key is configured (best effort).
    const incomingAuth = Array.isArray(req.headers["authorization"])
      ? req.headers["authorization"][0]
      : req.headers["authorization"];
    const bearer = typeof incomingAuth === "string" ? incomingAuth.replace(/^Bearer\s+/i, "") : "";
    delete fwdHeaders["authorization"];
    const key = config.anthropicApiKey || bearer;
    if (key) fwdHeaders["x-api-key"] = key;
    fwdHeaders["anthropic-version"] = config.anthropicVersion;
    fwdHeaders["content-type"] = "application/json";
  }

  const record = (
    status: number,
    streaming: boolean,
    respText: string,
    outMatched: Record<string, number>,
    blocked = false,
  ): void => recordEntry(status, streaming, respText, inbound, outMatched, blocked);

  // --- model policy: block before forwarding (nothing leaves the machine) ----
  if (isModelBlocked(model)) {
    record(403, false, "", {}, true);
    sendJson(res, 403, {
      error: "Model blocked by gateway policy",
      model,
      hint: "Unblock it in the console Model Policy tab.",
    });
    return;
  }

  // --- forward ---------------------------------------------------------------
  const call = forward(fwdRoute, method, fwdHeaders, cleanBody, config.upstreamTimeoutMs);
  // Abort upstream work if the client goes away — don't keep a socket + buffer
  // alive for a response nobody will read (§5).
  const onClientClose = (): void => {
    if (!res.writableEnded) call.req.destroy();
  };
  res.on("close", onClientClose);

  let upstream: IncomingMessage;
  try {
    upstream = await call.response;
  } catch (err) {
    record(502, false, "", {});
    if (!res.headersSent) {
      sendJson(res, 502, { error: "Upstream request failed", detail: String(err) });
    } else {
      res.end();
    }
    return;
  }

  const status = upstream.statusCode ?? 502;
  const upCt = upstream.headers["content-type"];

  // --- outbound scrub: streaming SSE ----------------------------------------
  if (isSse(upCt)) {
    // Redact on the upstream provider's framing first; for the Cursor translate
    // path, reframe the *already-redacted* Anthropic SSE into OpenAI chunks.
    const sr = new StreamRedactor(logProvider, config.streamHoldbackChars);
    const reframer = translating
      ? new AnthropicToOpenAISSE(clientModel ?? model ?? "claude", nowSeconds, chunkId)
      : null;
    const pipe = (redacted: Buffer): Buffer => (reframer ? reframer.push(redacted) : redacted);
    const headers = respHeaders(upstream.headers);
    res.writeHead(status, headers);
    let respText = "";
    const emit = (buf: Buffer): void => {
      if (buf.length === 0) return;
      res.write(buf);
      const cap = config.snapshotChars;
      if (cap <= 0 || respText.length < cap) respText += buf.toString("utf8");
    };
    upstream.on("data", (c: Buffer) =>
      emit(pipe(sr.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))),
    );
    upstream.on("end", () => {
      emit(pipe(sr.flush()));
      if (reframer) emit(reframer.flush());
      res.end();
      record(status, true, respText, { ...sr.matched });
    });
    upstream.on("error", () => {
      res.end();
      record(status, true, respText, { ...sr.matched });
    });
    return;
  }

  // --- outbound scrub: buffered JSON / text ---------------------------------
  const chunks: Buffer[] = [];
  let bufferedBytes = 0;
  let overCap = false;
  const cap = config.responseCapBytes;
  upstream.on("data", (c: Buffer) => {
    if (overCap) return;
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    bufferedBytes += buf.length;
    // Bound non-SSE buffering so a huge/hostile upstream body can't exhaust
    // memory (§5). Past the cap we abort and fail closed with a 502.
    if (cap > 0 && bufferedBytes > cap) {
      overCap = true;
      upstream.destroy();
      record(502, false, "", {});
      if (!res.headersSent) sendJson(res, 502, { error: "Upstream response too large", maxBytes: cap });
      else res.end();
      return;
    }
    chunks.push(buf);
  });
  upstream.on("end", () => {
    if (overCap) return;
    const raw = Buffer.concat(chunks).toString("utf8");

    // Cursor translate path: redact the Anthropic response, then reshape to the
    // OpenAI chat.completion envelope Cursor expects.
    if (translating) {
      let anthObj: any = null;
      try {
        anthObj = JSON.parse(raw);
      } catch {
        anthObj = null;
      }
      let outText: string;
      let outMatched: Record<string, number> = {};
      if (anthObj && anthObj.type === "message") {
        const red = redactJson(anthObj, "outbound");
        outMatched = red.matched;
        const openai = anthropicToOpenAIResponse(red.value, clientModel ?? model ?? "claude", nowSeconds);
        if (!(openai as any).id) (openai as any).id = chunkId;
        outText = JSON.stringify(openai);
      } else {
        // Upstream error / non-message body: scrub, then wrap in an OpenAI error
        // shape so Cursor surfaces it cleanly (never forward raw).
        const scrubbed = scrub(raw, upCt, "outbound");
        outMatched = scrubbed.matched;
        let errObj: any = null;
        try {
          errObj = JSON.parse(scrubbed.text);
        } catch {
          errObj = null;
        }
        const msg = errObj?.error?.message ?? errObj?.error ?? scrubbed.text ?? "upstream error";
        outText = JSON.stringify({ error: { message: String(msg), type: "upstream_error" } });
      }
      const outBuf = Buffer.from(outText, "utf8");
      const headers = respHeaders(upstream.headers);
      headers["content-type"] = "application/json";
      headers["content-length"] = String(outBuf.length);
      if (!res.headersSent) res.writeHead(status, headers);
      res.end(outBuf);
      record(status, false, outText, outMatched);
      return;
    }

    const out = scrub(raw, upCt, "outbound");
    const outBuf = Buffer.from(out.text, "utf8");
    const headers = respHeaders(upstream.headers);
    headers["content-length"] = String(outBuf.length);
    if (!res.headersSent) res.writeHead(status, headers);
    res.end(outBuf);
    record(status, false, out.text, out.matched);
  });
  upstream.on("error", () => {
    record(502, false, "", {});
    if (!res.headersSent) sendJson(res, 502, { error: "Upstream read failed" });
    else res.end();
  });
}
