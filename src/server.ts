// ===== SERVER (request dispatch + bootstrap) =================================
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LogEntry, Provider } from "./contracts.ts";
import type { GatewayConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { sendJson, readBody, BodyTooLargeError } from "./http-utils.ts";
import { resolveRoute } from "./routing.ts";
import { proxyRequest } from "./proxy.ts";
import { getActiveRuleInfo, redactText, redactJson } from "./redaction.ts";
import { trafficLog, setTrafficListener } from "./traffic-log.ts";
import { securityLog, type SecurityLogEntry } from "./security-log.ts";
import { analyze, type ClassifyFn } from "./prompt-analyzer.ts";
import { classifyViaAnthropic } from "./prompt-classifier.ts";
import { buildGuidance, hasBlockCategory } from "./guidance.ts";
import { handleMcpHttp, isMcpPath } from "./mcp.ts";
import { CONSOLE_HTML } from "./console.ts";
import { handleControlApi, isApiPath } from "./control-api.ts";
import { cleanEntry } from "./clean-view.ts";
import { isAdminPath, handleAdminApi } from "./admin-api.ts";
import { openAdminStore, surfaceOf } from "./admin-store.ts";
import { ADMIN_HTML } from "./admin-console.ts";

function sendHtml(res: ServerResponse, html: string): void {
  const body = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(body.length),
  });
  res.end(body);
}

/** True when the client wants an SSE stream (MCP legacy transport), not HTML. */
function wantsEventStream(req: IncomingMessage): boolean {
  const accept = String(req.headers["accept"] ?? "");
  return /text\/event-stream/i.test(accept);
}

/** A browser Origin is trusted only if it resolves to a loopback host (§5). */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost") return true;
    if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true; // IPv4 loopback /8
    if (/^(?:0*:)*0*1$/.test(host)) return true; // IPv6 loopback (::1)
    return false;
  } catch {
    return false;
  }
}

/**
 * Guard the control plane (/api, /logs, /rules, /mcp inspection). Non-browser
 * callers (curl, SDKs, MCP clients) send no `Origin` and are allowed. A browser
 * sends `Origin`: loopback origins pass; a foreign origin is rejected unless it
 * presents the admin token — this kills drive-by/CSRF access without breaking
 * local tools. Loopback-permissive by design (§5).
 */
function originAllowed(req: IncomingMessage, config: GatewayConfig): boolean {
  const origin = req.headers["origin"];
  if (origin === undefined) return true; // no browser origin -> local tool
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (isLoopbackOrigin(o)) return true;
  const token = req.headers["x-gateway-token"];
  const t = Array.isArray(token) ? token[0] : token;
  return config.adminToken !== "" && t === config.adminToken;
}

/**
 * A browser extension service worker calling the local hook endpoints presents an
 * extension-scheme Origin — `chrome-extension://` (Chrome/Edge), `moz-extension://`
 * (Firefox), or `safari-web-extension://` (Safari) — which is NOT loopback. Such an
 * origin is only reachable by an installed extension on this machine — a narrower
 * trust class than a foreign website (http/https origin), which stays blocked.
 * Allowed ONLY for the hook endpoints (/detect, /redact, /log-turn), which take
 * text and return a redaction result + match counts — they expose no stored
 * traffic, secrets, or control-plane state. (Gemini-web extension, 2026-07-20;
 * Firefox/Safari schemes added 2026-07-30 for the cross-browser port.)
 */
function isExtensionOrigin(origin: string | string[] | undefined): boolean {
  if (origin === undefined) return false;
  const o = Array.isArray(origin) ? origin[0] : origin;
  return /^(?:chrome-extension|moz-extension|safari-web-extension):\/\//i.test(o);
}

/** POST /api/* mutations: when adminToken is set, require token or loopback browser Origin. */
function mutationAllowed(req: IncomingMessage, config: GatewayConfig): boolean {
  if (config.adminToken === "") return true;
  const token = req.headers["x-gateway-token"];
  const t = Array.isArray(token) ? token[0] : token;
  if (t === config.adminToken) return true;
  const origin = req.headers["origin"];
  const o = Array.isArray(origin) ? origin[0] : origin;
  return o !== undefined && isLoopbackOrigin(o);
}

/** Control-plane access: loopback Origin (or admin token from a cross-origin caller). */
function controlPlaneAllowed(req: IncomingMessage, config: GatewayConfig): boolean {
  return originAllowed(req, config);
}

/**
 * CORS headers echoing a TRUSTED origin only — never a wildcard (§5). Two trust
 * classes are granted:
 *   - a loopback browser origin (127.0.0.1/localhost) → full control-plane CORS;
 *   - a browser-extension service-worker origin (chrome-extension://) → ONLY the
 *     hook endpoints (/detect, /redact, /log-turn), mirroring the access gate.
 * A foreign http(s) origin gets nothing.
 *
 * Also answers Chrome's Private Network Access preflight: a fetch to 127.0.0.1
 * from an extension SW (or a page) now carries `Access-Control-Request-Private-
 * Network: true`, and Chrome BLOCKS the request unless the response echoes
 * `Access-Control-Allow-Private-Network: true`. Without this the extension's
 * loopback fetch fails after a Chrome update → "gateway unreachable" → every
 * send blocked, nothing logged (regression fixed 2026-07-29).
 */
function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers["origin"];
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (!o) return {};
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const isHookPath = path === "/detect" || path === "/redact" || path === "/log-turn";
  const allow = isLoopbackOrigin(o) || (isExtensionOrigin(o) && isHookPath);
  if (!allow) return {};
  const headers: Record<string, string> = {
    "access-control-allow-origin": o,
    "vary": "Origin",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-gateway-token,mcp-session-id",
  };
  if (req.headers["access-control-request-private-network"] === "true") {
    headers["access-control-allow-private-network"] = "true";
  }
  return headers;
}

const NO_ROUTE_HINT = {
  error: "No route matched",
  hint: {
    message: "Prefix the path, set a provider header, or use a known API path.",
    pathPrefixes: ["/anthropic/*", "/gemini/*", "/openai/*"],
    providerHeader: "x-llm-provider: anthropic | gemini | openai",
    knownPaths: ["/v1/messages", "/v1/chat/completions", "/v1beta/*"],
  },
};

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // TEMP access log (debug Cursor validation) — path only, no bodies/secrets.
  process.stderr.write(`[access] ${new Date().toISOString()} ${method} ${req.url}\n`);

  // Apply CORS to EVERY response for a trusted origin — the preflight AND the
  // actual response need `access-control-allow-origin`, or the browser blocks
  // the extension SW from reading the redaction result (only the preflight was
  // covered before, which is why the SW fetch failed). setHeader now so it
  // survives whichever sendJson/sendHtml path runs below.
  for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);

  // CORS preflight short-circuit. Headers are already set above; a foreign
  // origin simply got none (§5) — never a wildcard.
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Frontend: the control-plane console (rules + allowlist + traffic inspector).
  if (method === "GET" && (path === "/" || path === "/console" || path === "/inspector")) {
    sendHtml(res, CONSOLE_HTML);
    return;
  }
  // GET /mcp in a BROWSER (Accept: text/html) serves the console; an MCP client
  // (Accept: text/event-stream) falls through to the legacy SSE transport below.
  if (method === "GET" && path === "/mcp" && !wantsEventStream(req)) {
    sendHtml(res, CONSOLE_HTML);
    return;
  }
  // Admin dashboard shell (login + analytics/controls/audit). Static HTML, like
  // the console; the data behind it is JWT-gated at /admin/api/*.
  if (method === "GET" && path === "/admin" && config.adminEnabled) {
    sendHtml(res, ADMIN_HTML);
    return;
  }

  // Admin endpoints — answered before touching the body.
  // /healthz carries a stable installId so an installer/doctor can confirm the
  // listener on :port is THIS gateway, not some unrelated local server (§1).
  if (method === "GET" && path === "/healthz") {
    sendJson(res, 200, {
      status: "ok",
      service: "secure-llm-gateway",
      installId: config.installId,
      host: config.host,
      port: config.port,
    });
    return;
  }

  // Cursor validates a custom model by GETting `/v1/models` on its "Override
  // OpenAI Base URL". Match BOTH the `/openai/...` prefix and the bare root
  // (`/v1/models`, `/models`) — Cursor's base URL may or may not include the
  // `/openai` segment, and root chat already routes to the shim, so models must
  // answer at root too or validation 404s while chat works. Otherwise it is
  // proxied to real OpenAI that 401s on the dummy key, so
  // Cursor reports the model "not valid" and blocks the chat before any
  // translate request is ever sent. Answer it locally with a synthetic OpenAI
  // model list containing the translate aliases so validation passes. Loopback
  // bind, no secrets in the response.
  if (method === "GET" && /^\/(?:openai\/)?(?:v1\/)?models$/.test(path)) {
    const created = Math.floor(Date.now() / 1000);
    const data = [...new Set(config.cursorTranslateModels)].map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "gateway",
    }));
    sendJson(res, 200, { object: "list", data });
    return;
  }

  // Control plane is guarded (§5): loopback browser Origin (or admin token) only.
  // Exception: the local hook endpoints (/detect, /redact) also accept an
  // extension service-worker origin (chrome-extension://) — see isExtensionOrigin.
  const hookPath = path === "/detect" || path === "/redact" || path === "/log-turn";
  const controlPath =
    path === "/logs" || path === "/rules" || path === "/security-log" ||
    path === "/prompt-guard" || hookPath ||
    isApiPath(path) || isMcpPath(path) || isAdminPath(path);
  if (
    controlPath &&
    !controlPlaneAllowed(req, config) &&
    !(hookPath && isExtensionOrigin(req.headers["origin"]))
  ) {
    sendJson(res, 403, { error: "Origin not allowed" });
    return;
  }

  if (method === "GET" && path === "/logs") {
    const entries = trafficLog.recent(100, false);
    // ?clean=1 attaches a distilled { userPrompt, assistantOutput } per entry,
    // stripping Claude Code's injected boilerplate (system-reminder/system/tools).
    const clean = url.searchParams.get("clean") === "1";
    sendJson(res, 200, { entries: clean ? entries.map(cleanEntry) : entries });
    return;
  }
  if (method === "GET" && path === "/rules") {
    sendJson(res, 200, { rules: getActiveRuleInfo() });
    return;
  }
  // Raw prompt-guard security log (Checkpoint 1). MAY contain raw prompt text +
  // exact guidance, so it is stricter than /logs: when an admin token is
  // configured it MUST be presented (loopback origin alone is not enough).
  if (method === "GET" && path === "/security-log") {
    if (config.adminToken !== "") {
      const t = req.headers["x-gateway-token"];
      const tok = Array.isArray(t) ? t[0] : t;
      if (tok !== config.adminToken) {
        sendJson(res, 403, { error: "admin token required for the security log" });
        return;
      }
    }
    const n = Number(url.searchParams.get("limit") ?? 100);
    sendJson(res, 200, { entries: securityLog.recent(Number.isFinite(n) ? n : 100) });
    return;
  }

  // Read the body once, enforcing the cap up front (oversized -> 413).
  let bodyBuf: Buffer;
  try {
    bodyBuf = await readBody(req, config.bodyCapBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: "Payload too large", maxBytes: config.bodyCapBytes });
      return;
    }
    sendJson(res, 400, { error: "Failed to read request body" });
    return;
  }

  // Local PII detection for Cursor hooks (block-if-PII gate). Loopback-gated
  // above. This endpoint uses the LIVE rule set (incl. UI-added custom rules)
  // and NEVER logs — it returns only match counts, so no raw PII is persisted.
  if (method === "POST" && path === "/detect") {
    let text = "";
    try {
      const j = JSON.parse(bodyBuf.toString("utf8") || "{}");
      if (j && typeof j.text === "string") text = j.text;
    } catch {
      /* empty/invalid -> treated as no text */
    }
    const { matched } = redactText(text, "inbound");
    sendJson(res, 200, { matched, piiDetected: Object.keys(matched).length > 0 });
    return;
  }

  // Local PII SCRUB for Cursor rewrite hooks (preToolUse/postToolUse, Phase L).
  // Unlike /detect this returns the REDACTED content so the hook can forward a
  // clean payload. Loopback-gated above; NEVER logs (raw text stays in memory
  // only for the duration of the call). Accepts { text } (string) or { value }
  // (arbitrary JSON — every string leaf scrubbed via redactJson).
  if (method === "POST" && path === "/redact") {
    let body: { text?: unknown; value?: unknown; source?: unknown; audit?: unknown } = {};
    try {
      const j = JSON.parse(bodyBuf.toString("utf8") || "{}");
      if (j && typeof j === "object") body = j;
    } catch {
      /* empty/invalid -> treated as no content */
    }
    // Audit entry: record that a scrub happened, its matched rule COUNTS, and the
    // SCRUBBED text — the same tokenised text handed back to the hook, so storing
    // it keeps the never-persist-raw-PII invariant while letting the inspector show
    // WHAT was scrubbed instead of an empty row. Capped by SNAPSHOT_CHARS, since a
    // tool payload can be a whole file.
    // `audit:false` suppresses this entirely — used by the Gemini extension,
    // which logs a single richer per-turn entry via /log-turn instead (so a
    // send-time counts-only row doesn't duplicate the turn row).
    const source = typeof body.source === "string" ? body.source : "cursor:tool-scrub";
    const doAudit = body.audit !== false;
    // Which pane the text belongs in: a postToolUse scrub is what the tool
    // RETURNED (response), anything else is what we were about to SEND (request).
    const isOutputSide = /postToolUse/i.test(source);
    const audit = (
      matched: Record<string, number>,
      reqLen: number,
      respLen: number,
      redacted: string,
    ): void => {
      if (!doAudit) return;
      if (Object.keys(matched).length === 0) return; // only log scrubs that found PII
      const cap = config.snapshotChars;
      const snapshot = cap > 0 ? redacted.slice(0, cap) : redacted;
      const entry: LogEntry = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        provider: "openai", // Cursor's API family; this is a hook-side scrub event
        method: "HOOK",
        path: source,
        status: 200,
        streaming: false,
        durationMs: 0,
        charCount: { request: reqLen, response: respLen, total: reqLen + respLen },
        payloadSnapshot: isOutputSide
          ? { request: "", response: snapshot }
          : { request: snapshot, response: "" },
        piiDetected: true,
        matchedRules: { inbound: matched, outbound: {} },
        // Tool payloads are raw text/JSON, not a provider envelope, so hand the
        // clean view the text verbatim rather than letting it try to parse one.
        clean: isOutputSide
          ? { userPrompt: "", assistantOutput: snapshot }
          : { userPrompt: snapshot, assistantOutput: "" },
      };
      trafficLog.push(entry);
    };
    if (typeof body.text === "string") {
      const { text, matched } = redactText(body.text, "inbound");
      audit(matched, body.text.length, text.length, text);
      sendJson(res, 200, { redacted: text, matched, piiDetected: Object.keys(matched).length > 0 });
      return;
    }
    if (body.value !== undefined) {
      const { value, matched } = redactJson(body.value, "inbound");
      const outText = JSON.stringify(value ?? "", null, 2);
      const outLen = JSON.stringify(value ?? "").length;
      audit(matched, JSON.stringify(body.value ?? "").length, outLen, outText);
      sendJson(res, 200, { redacted: value, matched, piiDetected: Object.keys(matched).length > 0 });
      return;
    }
    // Nothing to scrub -> echo empty, no PII.
    sendJson(res, 200, { redacted: "", matched: {}, piiDetected: false });
    return;
  }

  // Per-turn chat logging for browser-extension clients (Gemini web, Phase G).
  // The extension can't route chat through the proxy (the app calls the provider
  // from Google's servers), so it POSTs the turn here AFTER the assistant replies:
  // { prompt, response, model, source }. We REDACT both server-side (defense —
  // the prompt is already redacted client-side; the response is redacted here so
  // any model-generated PII never persists) and store ONE rich entry so the
  // Traffic Inspector shows this turn exactly like a Claude turn: provider +
  // model, and a clean { userPrompt, assistantOutput } view. Only redacted text
  // is stored (never-log-raw-PII invariant). Loopback/extension-origin gated above.
  if (method === "POST" && path === "/log-turn") {
    let body: {
      prompt?: unknown;
      response?: unknown;
      model?: unknown;
      source?: unknown;
      provider?: unknown;
      unchecked?: unknown;
      // Attached-file / selection content that rode along in the request but never
      // passed the block gate (Cursor auto-attaches open/selected files without a
      // beforeSubmitPrompt event — see Phase O). Scanned for PII counts only; its
      // text is deliberately NOT stored or shown, just as the tool-scrub audit does.
      scanExtra?: unknown;
    } = {};
    try {
      const j = JSON.parse(bodyBuf.toString("utf8") || "{}");
      if (j && typeof j === "object") body = j;
    } catch {
      /* empty/invalid -> treated as no content */
    }
    const rawPrompt = typeof body.prompt === "string" ? body.prompt : "";
    const rawResponse = typeof body.response === "string" ? body.response : "";
    // `provider` stays inside the FROZEN Provider enum. Cursor turns log as
    // "openai" (Cursor's API family — same choice the tool-scrub audit makes);
    // the console labels them "cursor" from `source`, so no contract changes.
    const turnProvider: Provider =
      body.provider === "anthropic" || body.provider === "openai" ? body.provider : "gemini";
    const model =
      typeof body.model === "string" && body.model
        ? body.model
        : turnProvider === "gemini"
          ? "gemini"
          : undefined;
    const source = typeof body.source === "string" ? body.source : "gemini-web-extension";
    // Redact both directions. The prompt is scrubbed inbound-style (real tokens);
    // the response outbound-style — but we want readable tokens in the inspector,
    // so scrub the response inbound-style too (it has no raw PII by construction,
    // this is belt-and-suspenders for model-generated values).
    const { text: redPrompt, matched: promptMatched } = redactText(rawPrompt, "inbound");
    const { text: redResponse, matched: respMatched } = redactText(rawResponse, "inbound");
    // Attachment content: redact ONLY to count its PII — the redacted text is
    // discarded, never stored or displayed (counts-only, like the Phase L audit).
    const rawExtra = typeof body.scanExtra === "string" ? body.scanExtra : "";
    const extraMatched = rawExtra ? redactText(rawExtra, "inbound").matched : {};
    // Inbound counts = the displayed prompt PLUS any auto-attached content. The two
    // are disjoint (the hook sends the attachment separately from the typed text),
    // so summing per type gives the true PII total that reached the model.
    const inboundMatched: Record<string, number> = { ...promptMatched };
    for (const [rule, n] of Object.entries(extraMatched)) {
      inboundMatched[rule] = (inboundMatched[rule] ?? 0) + n;
    }
    const attachmentLeaked = Object.keys(extraMatched).length > 0;
    const piiDetected =
      Object.keys(inboundMatched).length > 0 || Object.keys(respMatched).length > 0;
    const entry: LogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      provider: turnProvider,
      model,
      method: "CHAT",
      path: source,
      status: 200,
      streaming: false,
      durationMs: 0,
      charCount: {
        request: redPrompt.length,
        response: redResponse.length,
        total: redPrompt.length + redResponse.length,
      },
      // Store REDACTED text only. These feed both the raw-snapshot view and the
      // clean view below.
      payloadSnapshot: { request: redPrompt, response: redResponse },
      piiDetected,
      matchedRules: { inbound: inboundMatched, outbound: respMatched },
      // Pre-distilled clean view: for Gemini the prompt/response are already the
      // plain user/assistant text (no Claude JSON envelope), so cleanEntry uses
      // these verbatim instead of trying to parse a Claude-shaped snapshot.
      clean: { userPrompt: redPrompt, assistantOutput: redResponse },
    };
    // A turn is `unchecked` when it carried PII the block gate never saw. Two such
    // paths exist, both unblockable in-hook: a QUEUED send (caller flags it —
    // Cursor skips beforeSubmitPrompt on the drain path), and an AUTO-ATTACHED
    // file/selection (detected here — its content never reaches the prompt hook).
    // Either way the flag makes the leak visible rather than silent; see contracts.ts.
    if (body.unchecked === true || attachmentLeaked) entry.unchecked = true;
    trafficLog.push(entry);
    // Back-fill Cursor's model reply onto the matching flagged prompt-guard row in
    // the SECURITY log, so a reviewer sees prompt + guidance + output in ONE record
    // even though Cursor's reply is off-wire. Scoped to Cursor turns; correlates by
    // prompt text (the two Cursor hooks share no turn id). Stores the REDACTED reply
    // (`redResponse`), matching the claude-code path. No-op if nothing matches.
    if (source.startsWith("cursor")) {
      securityLog.attachResponse("cursor-hook", rawPrompt, redResponse);
    }
    sendJson(res, 200, { logged: true, piiDetected });
    return;
  }

  // Prompt-guard decision endpoint for the CURSOR surface (Checkpoint 1, Build 2).
  // Cursor traffic is NOT on the gateway wire, so the Cursor beforeSubmitPrompt
  // hook (`scripts/cursor-prompt-guard-hook.mjs`) POSTs the prompt here; we run
  // the SAME analyzer as the Claude Code proxy path, log the decision to the
  // admin-gated security log (surface: cursor-hook), and return the verdict.
  //
  // The hook can only ALLOW/BLOCK (Cursor's beforeSubmitPrompt is block-only —
  // it cannot inject context; verified 2026-08-05). The Cursor guidance INJECTION
  // is delivered separately by static `.cursor/rules/` (generated from the SAME
  // `src/guidance.ts`), so this endpoint is effectively LOG + severe-block only.
  // v1 has no active block category, so it logs and returns block:false.
  //
  // Tier-2 reuses the gateway's OWN configured Anthropic key + upstream — Cursor
  // sends no per-request auth here, unlike the Claude Code path which reuses the
  // request's own auth. No key configured => Tier-1 only (documented degrade).
  //
  // FAIL-OPEN (deliberate inverse of PII redaction, which fails CLOSED): any error
  // returns allow / block:false. A missed injection = no guidance, never a dropped
  // Cursor send. NEVER writes the raw prompt to the PII-safe traffic log.
  if (method === "POST" && path === "/prompt-guard") {
    const allowResp = { verdict: "allow", categories: [], block: false, guidance: "" };
    if (!config.promptGuardEnabled) {
      sendJson(res, 200, allowResp);
      return;
    }
    let prompt = "";
    let surface: SecurityLogEntry["surface"] = "cursor-hook";
    try {
      const j = JSON.parse(bodyBuf.toString("utf8") || "{}");
      if (j && typeof j.prompt === "string") prompt = j.prompt;
      if (j && (j.surface === "cursor-rules" || j.surface === "cursor-hook")) surface = j.surface;
    } catch {
      /* empty/invalid -> nothing to analyze */
    }
    try {
      let classify: ClassifyFn | undefined;
      if (config.promptGuardTier2 && config.anthropicApiKey) {
        classify = classifyViaAnthropic({
          upstreamBase: config.upstreams.anthropic,
          headers: {
            "x-api-key": config.anthropicApiKey,
            "anthropic-version": config.anthropicVersion,
          },
          model: config.promptGuardModel,
          timeoutMs: config.promptGuardTimeoutMs,
        });
      }
      const verdict = await analyze(prompt, {
        tier2Enabled: config.promptGuardTier2,
        classify,
        timeoutMs: config.promptGuardTimeoutMs,
      });
      if (verdict.verdict === "allow") {
        sendJson(res, 200, { verdict: "allow", categories: [], block: false, guidance: "" });
        return;
      }
      const guidance = buildGuidance(verdict.categories);
      const block = verdict.verdict === "block" && hasBlockCategory(verdict.categories);
      // RAW prompt + exact guidance -> admin-gated security log ONLY (never the
      // PII-safe traffic log). Mirrors the Claude Code path's securityLog.push.
      securityLog.push({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        surface,
        verdict: verdict.verdict,
        categories: verdict.categories,
        confidence: verdict.confidence,
        tier: verdict.tier,
        rawPrompt: prompt,
        guidance: block ? "" : guidance,
        provider: "cursor",
      });
      sendJson(res, 200, {
        verdict: verdict.verdict,
        categories: verdict.categories,
        block,
        guidance: block ? "" : guidance,
      });
    } catch {
      sendJson(res, 200, allowResp);
    }
    return;
  }

  // Admin control plane — dashboard API (JWT-gated) + enforcement internals
  // (loopback-gated above). Self-contained; never throws to the caller.
  if (isAdminPath(path)) {
    handleAdminApi(req, res, config, bodyBuf, method, url);
    return;
  }

  // Control plane — console API (rule toggles, custom rules, allowlist).
  if (isApiPath(path)) {
    if (method === "POST" && !mutationAllowed(req, config)) {
      sendJson(res, 401, { error: "Admin token required for control-plane mutations" });
      return;
    }
    handleControlApi(req, res, bodyBuf, method, path);
    return;
  }

  // Control plane — MCP server (Streamable HTTP + legacy HTTP+SSE).
  if (isMcpPath(path)) {
    handleMcpHttp(req, res, bodyBuf, method, url);
    return;
  }

  // Data plane — resolve provider and proxy.
  const route = resolveRoute(req, config.upstreams, {
    allowUpstreamOverride: config.allowUpstreamOverride,
  });
  if (!route) {
    sendJson(res, 404, NO_ROUTE_HINT);
    return;
  }
  await proxyRequest(req, res, bodyBuf, route, config);
}

/** Create (but do not start) the gateway HTTP server. Tests inject config overrides. */
export function createGatewayServer(overrides: Partial<GatewayConfig> = {}): http.Server {
  const config = loadConfig(overrides);

  // Persist one analytics event per decision (metadata only — never raw PII).
  // A single traffic-log listener covers EVERY decision site (proxy, /redact,
  // /log-turn) without editing them; wrapped so it can never affect traffic.
  if (config.adminEnabled) {
    try {
      const store = openAdminStore(config.adminDbPath);
      setTrafficListener((e: LogEntry) => {
        const inbound = e.matchedRules?.inbound ?? {};
        const outbound = e.matchedRules?.outbound ?? {};
        const types = Array.from(new Set([...Object.keys(inbound), ...Object.keys(outbound)]));
        store.recordEvent({
          surface: surfaceOf(e),
          direction: Object.keys(inbound).length ? "outgoing" : Object.keys(outbound).length ? "incoming" : "outgoing",
          decision: e.blocked ? "blocked" : e.piiDetected ? "redacted" : "allowed",
          pii_types: types,
          latency_ms: e.durationMs,
        });
      });
    } catch {
      /* if the store can't open, the gateway still runs — admin is just inert */
    }
  }

  return http.createServer((req, res) => {
    handleRequest(req, res, config).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
      else res.end();
    });
  });
}
