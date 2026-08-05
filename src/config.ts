// ===== CONFIG ================================================================
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "./contracts.ts";

export interface GatewayConfig {
  host: string;
  port: number;
  bodyCapBytes: number;
  streamHoldbackChars: number;
  /** Max chars kept per request/response snapshot in a log entry. 0 = unlimited. */
  snapshotChars: number;
  /** Max bytes buffered from a non-SSE upstream response before aborting (0 = unlimited). */
  responseCapBytes: number;
  /** Upstream socket connect/read timeout in ms (0 = no timeout). */
  upstreamTimeoutMs: number;
  /** Honor per-request `x-llm-upstream` overrides (loopback targets only). Test/dev only. */
  allowUpstreamOverride: boolean;
  /** Optional admin token; lets a cross-origin caller bypass the browser-origin guard. */
  adminToken: string;
  /** Stable identity for this gateway deployment, surfaced on /healthz. */
  installId: string;
  upstreams: Record<Provider, string>;
  /** Cursor translation path (OpenAI->Anthropic). Server-side Anthropic auth so
   *  the real key never touches the client; model aliasing; token/version defaults. */
  anthropicApiKey: string;
  anthropicVersion: string;
  /** Map an incoming (alias) model id to a real Claude model, for translated calls. */
  cursorModelMap: Record<string, string>;
  /** Model ids that trigger translation to Anthropic on the shared OpenAI endpoint.
   *  ("claude-*" ids always translate; these are extra non-claude aliases.) */
  cursorTranslateModels: string[];
  /** Fallback Claude model when a translated id isn't in the map and isn't a Claude id. */
  cursorDefaultModel: string;
  /** Anthropic requires max_tokens; used when the OpenAI request omits it. */
  cursorMaxTokens: number;
  /** Admin control-plane (dashboard/analytics/controls). When false the whole
   *  `/admin` + `/internal` subsystem is inert (no DB opened). */
  adminEnabled: boolean;
  /** SQLite file backing the admin subsystem (events, config, users, audit). */
  adminDbPath: string;
}

// Cursor exposes ONE global "Override OpenAI Base URL", so a single gateway
// endpoint serves both GPT (pass-through) and Claude (translated). Routing is by
// MODEL NAME: a "claude-*" id or one of these aliases -> translate to Anthropic;
// anything else -> pass through to OpenAI. `cursorModelMap` then resolves the
// alias to a real Claude model.
// Override with CURSOR_TRANSLATE_MODELS to add aliases.
const DEFAULT_CURSOR_TRANSLATE_MODELS = ["claude-via-gateway"];

/** Alias -> real Claude model; overridable via CURSOR_MODEL_MAP (JSON). */
const DEFAULT_CURSOR_MODEL_MAP: Record<string, string> = {
  "claude-via-gateway": "claude-sonnet-5",
};

function parseCsv(raw: string | undefined, fallback: string[]): string[] {
  if (!raw || raw.trim() === "") return [...fallback];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function parseModelMap(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === "") return { ...DEFAULT_CURSOR_MODEL_MAP };
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const out: Record<string, string> = {};
      for (const k of Object.keys(obj)) {
        if (typeof (obj as any)[k] === "string") out[k.toLowerCase()] = (obj as any)[k];
      }
      return out;
    }
  } catch {
    /* malformed -> fall back to defaults */
  }
  return { ...DEFAULT_CURSOR_MODEL_MAP };
}

/** Loopback hosts the gateway is permitted to bind. Never bind a routable address. */
// (removed — loopback check is now structural, see isLoopbackHost) new Set(["[REDACTED_PII_IPV4]", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true; // IPv4 loopback /8 block
  if (/^(?:0*:)*0*1$/.test(h)) return true; // IPv6 loopback (::1 and expanded forms)
  return false;
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function toIntAllowZero(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Build config from environment with sane defaults; overrides win (tests use them). */
export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const base: GatewayConfig = {
    // Loopback-only: the gateway never binds a routable address (§1, §5).
    host: process.env.GATEWAY_HOST ?? "127.0.0.1",
    port: toInt(process.env.GATEWAY_PORT, 8001),
    bodyCapBytes: toInt(process.env.MAX_BODY_BYTES, 25 * 1024 * 1024),
    streamHoldbackChars: toInt(process.env.STREAM_HOLDBACK_CHARS, 96),
    // default 256 KB — captures a full Claude Code turn incl. the trailing
    // `system` prompt. Set SNAPSHOT_CHARS=0 for unlimited (more memory).
    snapshotChars: toIntAllowZero(process.env.SNAPSHOT_CHARS, 262144),
    responseCapBytes: toIntAllowZero(process.env.MAX_RESPONSE_BYTES, 25 * 1024 * 1024),
    upstreamTimeoutMs: toIntAllowZero(process.env.UPSTREAM_TIMEOUT_MS, 60_000),
    // Off by default: an untrusted client must not be able to redirect the
    // gateway's upstream. Enabled explicitly in dev/tests (loopback only, §5).
    allowUpstreamOverride: process.env.GATEWAY_ALLOW_UPSTREAM_OVERRIDE === "1",
    adminToken: process.env.GATEWAY_ADMIN_TOKEN ?? "",
    // Stable per-deployment id: the installer pins GATEWAY_INSTALL_ID in the
    // service env; unmanaged/test runs get a fresh in-memory id (no disk write).
    installId: process.env.GATEWAY_INSTALL_ID ?? randomUUID(),
    upstreams: {
      anthropic: process.env.ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com",
      gemini: process.env.GEMINI_UPSTREAM ?? "https://generativelanguage.googleapis.com",
      openai: process.env.OPENAI_COMPAT_UPSTREAM ?? "https://api.openai.com",
    },
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    anthropicVersion: process.env.ANTHROPIC_VERSION ?? "2023-06-01",
    cursorModelMap: parseModelMap(process.env.CURSOR_MODEL_MAP),
    cursorTranslateModels: parseCsv(
      process.env.CURSOR_TRANSLATE_MODELS,
      DEFAULT_CURSOR_TRANSLATE_MODELS,
    ),
    cursorDefaultModel: process.env.CURSOR_DEFAULT_MODEL ?? "claude-sonnet-5",
    cursorMaxTokens: toInt(process.env.CURSOR_MAX_TOKENS, 4096),
    // Admin control plane: on by default in production; GATEWAY_ADMIN=0 forces
    // off, =1 forces on. Default OFF under the node test runner so unrelated test
    // servers don't open/write the real ~/.secure-llm-gateway/admin.db — admin
    // tests opt in explicitly via the `adminEnabled` override.
    adminEnabled:
      process.env.GATEWAY_ADMIN === "1"
        ? true
        : process.env.GATEWAY_ADMIN === "0"
          ? false
          : !(process.execArgv.includes("--test") || process.env.NODE_ENV === "test"),
    adminDbPath:
      process.env.GATEWAY_ADMIN_DB ?? join(homedir(), ".secure-llm-gateway", "admin.db"),
  };
  const merged: GatewayConfig = {
    ...base,
    ...overrides,
    upstreams: { ...base.upstreams, ...(overrides.upstreams ?? {}) },
  };
  // Fail closed: the gateway binds loopback only, always (§1, §5).
  if (!isLoopbackHost(merged.host)) {
    throw new Error(
      `refusing to bind non-loopback host "${merged.host}" — the gateway is loopback-only`,
    );
  }
  return merged;
}
