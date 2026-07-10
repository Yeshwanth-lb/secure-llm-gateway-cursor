// ===== CONFIG ================================================================
import { randomUUID } from "node:crypto";
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
  /** When true (GATEWAY_REMOTE=1), bind 0.0.0.0 and require admin token on control plane. */
  remoteMode: boolean;
  /** Stable identity for this gateway deployment, surfaced on /healthz. */
  installId: string;
  upstreams: Record<Provider, string>;
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

/** True when running on Render (injects RENDER=true + PORT). */
export function isRenderRuntime(): boolean {
  return process.env.RENDER === "true";
}

/** Build config from environment with sane defaults; overrides win (tests use them). */
export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  // RENDER=true is injected by Render even when render.yaml env vars are missing.
  const remoteMode = process.env.GATEWAY_REMOTE === "1" || isRenderRuntime();
  const base: GatewayConfig = {
    host: process.env.GATEWAY_HOST ?? (remoteMode ? "0.0.0.0" : "127.0.0.1"),
    // Render/Heroku set PORT; fall back to GATEWAY_PORT then 8000.
    port: toInt(process.env.PORT ?? process.env.GATEWAY_PORT, 8000),
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
    remoteMode,
    // Stable per-deployment id: the installer pins GATEWAY_INSTALL_ID in the
    // service env; unmanaged/test runs get a fresh in-memory id (no disk write).
    installId: process.env.GATEWAY_INSTALL_ID ?? randomUUID(),
    upstreams: {
      anthropic: process.env.ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com",
      gemini: process.env.GEMINI_UPSTREAM ?? "https://generativelanguage.googleapis.com",
      openai: process.env.OPENAI_COMPAT_UPSTREAM ?? "https://api.openai.com",
    },
  };
  const merged: GatewayConfig = {
    ...base,
    ...overrides,
    upstreams: { ...base.upstreams, ...(overrides.upstreams ?? {}) },
  };
  // Fail closed: local installs bind loopback only (§1, §5).
  if (!merged.remoteMode && !isLoopbackHost(merged.host)) {
    throw new Error(
      `refusing to bind non-loopback host "${merged.host}" — set GATEWAY_REMOTE=1 for cloud deploy`,
    );
  }
  if (merged.remoteMode && merged.host !== "0.0.0.0" && !isLoopbackHost(merged.host)) {
    throw new Error(
      `remote mode binds 0.0.0.0 or loopback only, not "${merged.host}"`,
    );
  }
  if (merged.remoteMode && merged.adminToken === "") {
    throw new Error(
      "remote deploy requires GATEWAY_ADMIN_TOKEN (set in Render Environment)",
    );
  }
  return merged;
}
