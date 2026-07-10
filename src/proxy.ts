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
import type { RouteResult, LogEntry } from "./contracts.ts";
import { buildForwardHeaders } from "./routing.ts";
import { redactJson, redactText } from "./redaction.ts";
import { StreamRedactor } from "./stream-redactor.ts";
import { trafficLog } from "./traffic-log.ts";
import { sendJson } from "./http-utils.ts";
import { extractModel, isModelBlocked } from "./model-policy.ts";

/** Cap a snapshot string; cap <= 0 means unlimited. */
const snap = (s: string, cap: number): string => (cap > 0 ? s.slice(0, cap) : s);

const isJson = (ct?: string): boolean => !!ct && /application\/json/i.test(ct);
const isSse = (ct?: string): boolean => !!ct && /text\/event-stream/i.test(ct);
const hasKeys = (m: Record<string, number>): boolean => Object.keys(m).length > 0;

/** Scrub a body toward the given direction; JSON deep-walked, else raw text. */
function scrub(
  raw: string,
  contentType: string | undefined,
  dir: "inbound" | "outbound",
): { text: string; matched: Record<string, number> } {
  if (raw === "") return { text: "", matched: {} };
  if (isJson(contentType)) {
    try {
      const { value, matched } = redactJson(JSON.parse(raw), dir);
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
): Promise<IncomingMessage> {
  const target = new URL(route.upstreamBase + route.forwardPath);
  const mod = target.protocol === "https:" ? https : http;
  const opts: https.RequestOptions = {
    method,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    headers: { ...headers, "content-length": String(body.length) },
  };
  return new Promise((resolve, reject) => {
    const r = mod.request(opts, resolve);
    r.on("error", reject);
    if (body.length) r.write(body);
    r.end();
  });
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
  const path = req.url ?? "/";
  const reqCt = req.headers["content-type"];

  // --- inbound scrub (before any byte leaves the machine) --------------------
  const inbound = scrub(bodyBuf.toString("utf8"), reqCt, "inbound");
  const cleanBody = Buffer.from(inbound.text, "utf8");
  const fwdHeaders = buildForwardHeaders(req, route);
  const model = extractModel(route.provider, route.forwardPath, bodyBuf.toString("utf8"));

  const record = (
    status: number,
    streaming: boolean,
    respText: string,
    outMatched: Record<string, number>,
    blocked = false,
  ): void => {
    const entry: LogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      provider: route.provider,
      model,
      blocked,
      method,
      path,
      status,
      streaming,
      durationMs: Date.now() - started,
      charCount: {
        request: inbound.text.length,
        response: respText.length,
        total: inbound.text.length + respText.length,
      },
      payloadSnapshot: {
        request: snap(inbound.text, config.snapshotChars),
        response: snap(respText, config.snapshotChars),
      },
      piiDetected: hasKeys(inbound.matched) || hasKeys(outMatched),
      matchedRules: { inbound: inbound.matched, outbound: outMatched },
    };
    trafficLog.push(entry);
  };

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
  let upstream: IncomingMessage;
  try {
    upstream = await forward(route, method, fwdHeaders, cleanBody);
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
    const sr = new StreamRedactor(route.provider, config.streamHoldbackChars);
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
      emit(sr.push(Buffer.isBuffer(c) ? c : Buffer.from(c))),
    );
    upstream.on("end", () => {
      emit(sr.flush());
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
  upstream.on("data", (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  upstream.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
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
