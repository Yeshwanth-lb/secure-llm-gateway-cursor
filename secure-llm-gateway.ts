#!/usr/bin/env node
// =============================================================================
// secure-llm-gateway.ts — single-file, zero-dependency local LLM gateway proxy
// -----------------------------------------------------------------------------
// Node >= 22 built-ins only. Redacts PII bidirectionally, logs post-redaction
// traffic in a ring buffer, and exposes an embedded MCP server. Design authority:
// newplan.md > PRD.md > IMPLEMENTATION_GUIDE.md.
//
// Run:   node --experimental-strip-types secure-llm-gateway.ts
// stdio: node --experimental-strip-types secure-llm-gateway.ts --stdio
//
// PHASE 0 (this file's current state): skeleton, config loader, frozen-contract
// stubs (throw "not implemented"), body-cap enforcement, GET /healthz, 404 hint.
// Everything past Phase 0 lands behind these seams — see the Project Status
// Ledger in CLAUDE.md §8.
// =============================================================================

import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// ===== FROZEN CONTRACTS (IMPLEMENTATION_GUIDE.md "Contracts") =================
// Locked in Phase 0. Change only by mutual agreement. Both workstreams code
// against these seams; the stubs below pass/throw until their phase fills them.

export type Provider = "anthropic" | "gemini" | "openai";

export interface RouteResult {
  provider: Provider;
  upstreamBase: string; // resolved base URL
  forwardPath: string; // path after prefix-strip
}

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  validate?: (match: string) => boolean; // e.g. Luhn for CREDIT_CARD
}

// inbound -> [REDACTED_PII_<TYPE>], outbound -> [REDACTED_MOCK_PII]
export type Direction = "inbound" | "outbound";

export interface RedactResult {
  text: string;
  matched: Record<string, number>;
}

export interface CharCount {
  request: number;
  response: number;
  total: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  provider: Provider;
  method: string;
  path: string;
  status: number;
  streaming: boolean;
  durationMs: number;
  charCount: CharCount;
  payloadSnapshot: { request: string; response: string };
  piiDetected: boolean;
  matchedRules: {
    inbound: Record<string, number>;
    outbound: Record<string, number>;
  };
}

// ===== CONFIG ================================================================

export interface GatewayConfig {
  host: string;
  port: number;
  bodyCapBytes: number;
  streamHoldbackChars: number;
  upstreams: Record<Provider, string>;
}

const NOT_IMPL = "not implemented (phase pending)";

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Build config from environment with sane defaults; overrides win (tests use them). */
export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const base: GatewayConfig = {
    host: process.env.GATEWAY_HOST ?? "127.0.0.1",
    port: toInt(process.env.GATEWAY_PORT, 8000),
    bodyCapBytes: toInt(process.env.MAX_BODY_BYTES, 25 * 1024 * 1024),
    streamHoldbackChars: toInt(process.env.STREAM_HOLDBACK_CHARS, 96),
    upstreams: {
      anthropic: process.env.ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com",
      gemini: process.env.GEMINI_UPSTREAM ?? "https://generativelanguage.googleapis.com",
      openai: process.env.OPENAI_COMPAT_UPSTREAM ?? "https://api.openai.com",
    },
  };
  return {
    ...base,
    ...overrides,
    upstreams: { ...base.upstreams, ...(overrides.upstreams ?? {}) },
  };
}

// ===== REDACTION ENGINE (Phase A1) ==========================================
// newplan.md §3. Pure functions — server/logging side effects stay at the edges.

/** Luhn checksum — kills false-positive credit-card matches (§3.1). */
function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// 7 default rules (§3.1). Order matters only for exact-tie overlap resolution.
export const DEFAULT_RULES: RedactionRule[] = [
  {
    name: "API_KEY",
    pattern:
      /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/g,
  },
  { name: "BEARER_TOKEN", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { name: "EMAIL", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    name: "CREDIT_CARD",
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    validate: luhnValid,
  },
  { name: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    name: "IPV4",
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  {
    // require >=4 groups so wall-clock "12:34:56" doesn't match (§3.1)
    name: "IPV6",
    pattern:
      /\b(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}\b|::(?:[0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4}\b/g,
  },
];

interface RuleSource {
  rule: RedactionRule;
  source: "custom-env" | "custom-file" | "default";
}

let ACTIVE_RULES: RuleSource[] | null = null;

function parseCustomRules(
  json: string,
  source: "custom-env" | "custom-file",
): RuleSource[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid ${source} JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(arr)) throw new Error(`${source} must be a JSON array`);
  return arr.map((raw, i) => {
    const r = raw as { name?: string; pattern?: string; flags?: string };
    if (!r || typeof r.name !== "string" || typeof r.pattern !== "string") {
      throw new Error(`${source}[${i}] needs string "name" and "pattern"`);
    }
    const flags = r.flags ?? "g";
    let pattern: RegExp;
    try {
      pattern = new RegExp(r.pattern, flags.includes("g") ? flags : flags + "g");
    } catch (e) {
      throw new Error(`${source}[${i}] bad regex: ${(e as Error).message}`);
    }
    return { rule: { name: r.name, pattern }, source };
  });
}

/** Compile rules once (custom merged AHEAD of defaults — they win exact ties). */
function getRuleSources(): RuleSource[] {
  if (ACTIVE_RULES) return ACTIVE_RULES;
  const custom: RuleSource[] = [];
  if (process.env.CUSTOM_REGEX_RULES) {
    custom.push(...parseCustomRules(process.env.CUSTOM_REGEX_RULES, "custom-env"));
  }
  if (process.env.CUSTOM_REGEX_RULES_FILE) {
    const body = fs.readFileSync(process.env.CUSTOM_REGEX_RULES_FILE, "utf8");
    custom.push(...parseCustomRules(body, "custom-file"));
  }
  ACTIVE_RULES = [
    ...custom,
    ...DEFAULT_RULES.map((rule) => ({ rule, source: "default" as const })),
  ];
  return ACTIVE_RULES;
}

/** Active rule names + provenance — feeds a future GET /rules (§4). */
export function getActiveRuleInfo(): { name: string; source: string }[] {
  return getRuleSources().map((rs) => ({ name: rs.rule.name, source: rs.source }));
}

/** Test/reload seam: drop the compiled-rule cache so env changes take effect. */
export function resetRedactionRules(): void {
  ACTIVE_RULES = null;
}

function tokenFor(dir: Direction, ruleName: string): string {
  return dir === "inbound" ? `[REDACTED_PII_${ruleName}]` : "[REDACTED_MOCK_PII]";
}

interface Match {
  start: number;
  end: number;
  name: string;
}

/** Scrub one string. Never throws on any input — the fail-safe raw-text path. */
export function redactText(text: string, dir: Direction): RedactResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text: typeof text === "string" ? text : String(text), matched: {} };
  }
  const matches: Match[] = [];
  for (const { rule } of getRuleSources()) {
    // clone with global flag so lastIndex state is never shared across calls
    const flags = rule.pattern.flags.includes("g")
      ? rule.pattern.flags
      : rule.pattern.flags + "g";
    const re = new RegExp(rule.pattern.source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === "") {
        re.lastIndex++; // zero-length-match guard (§7)
        continue;
      }
      if (rule.validate && !rule.validate(m[0])) continue;
      matches.push({ start: m.index, end: m.index + m[0].length, name: rule.name });
    }
  }
  if (matches.length === 0) return { text, matched: {} };

  // §3.2: sort by start asc, longest-first on ties; drop overlaps (first/longest wins).
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const matched: Record<string, number> = {};
  let out = "";
  let idx = 0;
  for (const mt of matches) {
    if (mt.start < idx) continue; // overlaps an already-emitted redaction
    out += text.slice(idx, mt.start) + tokenFor(dir, mt.name);
    matched[mt.name] = (matched[mt.name] ?? 0) + 1;
    idx = mt.end;
  }
  out += text.slice(idx);
  return { text: out, matched };
}

/** Deep-walk every string value in a JSON-ish structure. Object keys untouched. */
export function redactJson(
  obj: unknown,
  dir: Direction,
): { value: unknown; matched: Record<string, number> } {
  const matched: Record<string, number> = {};
  const merge = (m: Record<string, number>): void => {
    for (const k of Object.keys(m)) matched[k] = (matched[k] ?? 0) + m[k];
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactText(v, dir);
      merge(r.matched);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) {
        o[k] = walk((v as Record<string, unknown>)[k]);
      }
      return o;
    }
    return v;
  };
  return { value: walk(obj), matched };
}

// ===== CONTRACT STUBS (filled in later phases) ===============================

export function resolveRoute(_req: http.IncomingMessage): RouteResult {
  throw new Error(`resolveRoute: ${NOT_IMPL} (Phase B1)`);
}

export const trafficLog: {
  push(e: LogEntry): void;
  recent(limit: number, filterRedacted: boolean): LogEntry[];
} = {
  push(_e: LogEntry): void {
    throw new Error(`trafficLog.push: ${NOT_IMPL} (Phase B2)`);
  },
  recent(_limit: number, _filterRedacted: boolean): LogEntry[] {
    throw new Error(`trafficLog.recent: ${NOT_IMPL} (Phase B2)`);
  },
};

// ===== STREAM REDACTOR (Phase A2) ===========================================
// Outbound SSE holdback core (newplan.md §3.4). Feeds every provider text delta
// into ONE logical channel with a rolling holdback window so PII split across
// chunk boundaries is still caught, then re-serializes protocol-identical events.

interface SseEvent {
  fields: { name: string; value: string }[]; // ordered, preserves event:/id:/retry:/comments
  data: string; // joined multi-line data payload
}

/** Locate the provider's text delta inside a parsed event object (get + set). */
function locateDeltaText(
  provider: Provider,
  obj: unknown,
): { get: () => string; set: (v: string) => void } | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, any>;
  if (provider === "openai") {
    const ch = o.choices?.[0];
    if (ch?.delta && typeof ch.delta.content === "string") {
      return { get: () => ch.delta.content, set: (v) => (ch.delta.content = v) };
    }
    if (typeof ch?.text === "string") {
      return { get: () => ch.text, set: (v) => (ch.text = v) };
    }
  } else if (provider === "anthropic") {
    if (o.delta && typeof o.delta.text === "string") {
      return { get: () => o.delta.text, set: (v) => (o.delta.text = v) };
    }
    if (o.content_block && typeof o.content_block.text === "string") {
      return { get: () => o.content_block.text, set: (v) => (o.content_block.text = v) };
    }
  } else if (provider === "gemini") {
    const part = o.candidates?.[0]?.content?.parts?.[0];
    if (part && typeof part.text === "string") {
      return { get: () => part.text, set: (v) => (part.text = v) };
    }
  }
  return null;
}

function isTerminalEvent(provider: Provider, data: string, obj: unknown): boolean {
  if (data.trim() === "[DONE]") return true;
  const o = (obj ?? {}) as Record<string, any>;
  if (provider === "openai") return o.choices?.[0]?.finish_reason != null;
  if (provider === "anthropic") {
    return o.type === "content_block_stop" || o.type === "message_stop";
  }
  if (provider === "gemini") return o.candidates?.[0]?.finishReason != null;
  return false;
}

export class StreamRedactor {
  readonly provider: Provider;
  readonly holdback: number;
  readonly matched: Record<string, number> = {};

  private raw = ""; // incomplete SSE tail awaiting a frame boundary
  private textTail = ""; // withheld channel text inside the holdback window
  private lastDeltaTemplate: unknown = null; // structure to clone for synthetic flush
  private flushed = false;

  constructor(provider: Provider, holdback: number) {
    this.provider = provider;
    this.holdback = Math.max(0, holdback);
  }

  push(rawChunk: Buffer): Buffer {
    this.raw += rawChunk.toString("utf8");
    let out = "";
    // process only complete events; keep the incomplete tail buffered
    const sep = /\r?\n\r?\n/;
    while (true) {
      const m = sep.exec(this.raw);
      if (!m) break;
      const eventText = this.raw.slice(0, m.index);
      this.raw = this.raw.slice(m.index + m[0].length);
      if (eventText.trim() !== "") out += this.processEvent(eventText);
    }
    return Buffer.from(out, "utf8");
  }

  flush(): Buffer {
    return Buffer.from(this.emitFlush(), "utf8");
  }

  // ---- internals ----------------------------------------------------------

  private mergeMatched(m: Record<string, number>): void {
    for (const k of Object.keys(m)) this.matched[k] = (this.matched[k] ?? 0) + m[k];
  }

  /** Feed channel text; return the redacted portion safe to emit now. */
  private feed(text: string): string {
    const combined = this.textTail + text;
    let cut = Math.max(0, combined.length - this.holdback);
    // never cut inside a match that reaches into the holdback window — defer it
    for (const { rule } of getRuleSources()) {
      const flags = rule.pattern.flags.includes("g")
        ? rule.pattern.flags
        : rule.pattern.flags + "g";
      const re = new RegExp(rule.pattern.source, flags);
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(combined)) !== null) {
        if (mm[0] === "") {
          re.lastIndex++;
          continue;
        }
        if (rule.validate && !rule.validate(mm[0])) continue;
        const end = mm.index + mm[0].length;
        if (end > cut) cut = Math.min(cut, mm.index);
      }
    }
    const emitPart = combined.slice(0, cut);
    this.textTail = combined.slice(cut);
    const r = redactText(emitPart, "outbound");
    this.mergeMatched(r.matched);
    return r.text;
  }

  private parseEvent(eventText: string): SseEvent {
    const fields: { name: string; value: string }[] = [];
    const dataLines: string[] = [];
    for (const line of eventText.split(/\r?\n/)) {
      if (line.startsWith(":")) {
        fields.push({ name: ":comment", value: line.slice(1) });
        continue;
      }
      const ci = line.indexOf(":");
      const name = ci === -1 ? line : line.slice(0, ci);
      let value = ci === -1 ? "" : line.slice(ci + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (name === "data") dataLines.push(value);
      else fields.push({ name, value });
    }
    return { fields, data: dataLines.join("\n") };
  }

  private serialize(prefixFields: { name: string; value: string }[], data: string): string {
    let s = "";
    for (const f of prefixFields) {
      s += f.name === ":comment" ? `:${f.value}\n` : `${f.name}: ${f.value}\n`;
    }
    for (const line of data.split("\n")) s += `data: ${line}\n`;
    return s + "\n";
  }

  private processEvent(eventText: string): string {
    const ev = this.parseEvent(eventText);
    const nonData = ev.fields;

    // terminal signals that carry non-JSON data (OpenAI [DONE]) — flush first
    if (ev.data.trim() === "[DONE]") {
      const pre = this.emitFlush();
      return pre + this.serialize(nonData, ev.data);
    }

    let obj: unknown = null;
    let parsed = false;
    try {
      obj = JSON.parse(ev.data);
      parsed = true;
    } catch {
      // malformed JSON — stateless raw scrub, pass through, never crash (§7)
      const r = redactText(ev.data, "outbound");
      this.mergeMatched(r.matched);
      return this.serialize(nonData, r.text);
    }

    const loc = locateDeltaText(this.provider, obj);
    const terminal = isTerminalEvent(this.provider, ev.data, obj);

    if (loc) {
      this.lastDeltaTemplate = JSON.parse(JSON.stringify(obj)); // structural clone
      const emit = this.feed(loc.get());
      loc.set(emit);
      const body = this.serialize(nonData, JSON.stringify(obj));
      // terminal event that also carries text (Gemini): flush appended right before it
      if (terminal) return this.emitFlush() + body;
      return body;
    }

    // no text channel in this event
    if (terminal) return this.emitFlush() + this.serialize(nonData, JSON.stringify(obj));
    return this.serialize(nonData, parsed ? JSON.stringify(obj) : ev.data);
  }

  /** Release the withheld tail as a synthetic delta cloned from the last delta event. */
  private emitFlush(): string {
    if (this.flushed) return "";
    this.flushed = true;
    if (this.textTail === "") return "";
    const r = redactText(this.textTail, "outbound");
    this.mergeMatched(r.matched);
    this.textTail = "";
    if (this.lastDeltaTemplate) {
      const clone = JSON.parse(JSON.stringify(this.lastDeltaTemplate));
      const loc = locateDeltaText(this.provider, clone);
      if (loc) {
        loc.set(r.text);
        return this.serialize([], JSON.stringify(clone));
      }
    }
    // no template seen — emit a bare data event so nothing is dropped
    return this.serialize([], JSON.stringify({ text: r.text }));
  }
}

// ===== HTTP HELPERS ==========================================================

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  res.end(body);
}

class BodyTooLargeError extends Error {}

/** Read the full request body, aborting past `cap` bytes with BodyTooLargeError. */
function readBody(req: http.IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) {
        // over cap / already settled — drain remaining bytes, don't buffer.
        return;
      }
      size += chunk.length;
      if (size > cap) {
        fail(new BodyTooLargeError(`body exceeds ${cap} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", fail);
  });
}

// ===== REQUEST HANDLER =======================================================

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: GatewayConfig,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // Admin: health check — answered before touching the body.
  if (method === "GET" && path === "/healthz") {
    sendJson(res, 200, { status: "ok", service: "secure-llm-gateway" });
    return;
  }

  // Enforce the body cap up front so oversized payloads never reach routing.
  try {
    await readBody(req, config.bodyCapBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, {
        error: "Payload too large",
        maxBytes: config.bodyCapBytes,
      });
      return;
    }
    sendJson(res, 400, { error: "Failed to read request body" });
    return;
  }

  // Phase 0: routing/proxy not wired yet — everything else is an unknown route.
  sendJson(res, 404, {
    error: "No route matched",
    hint: {
      message: "Prefix the path, set a provider header, or use a known API path.",
      pathPrefixes: ["/anthropic/*", "/gemini/*", "/openai/*"],
      providerHeader: "x-llm-provider: anthropic | gemini | openai",
      knownPaths: ["/v1/messages", "/v1/chat/completions", "/v1beta/*"],
    },
  });
}

// ===== SERVER BOOTSTRAP ======================================================

/** Create (but do not start) the gateway HTTP server. Tests inject config overrides. */
export function createGatewayServer(overrides: Partial<GatewayConfig> = {}): http.Server {
  const config = loadConfig(overrides);
  return http.createServer((req, res) => {
    handleRequest(req, res, config).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
      else res.end();
    });
  });
}

function main(): void {
  const config = loadConfig();
  const server = createGatewayServer();
  server.listen(config.port, config.host, () => {
    process.stderr.write(
      `secure-llm-gateway listening on http://${config.host}:${config.port}\n`,
    );
  });
}

// Start only when executed directly, not when imported by the test runner.
const isEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntry) main();
