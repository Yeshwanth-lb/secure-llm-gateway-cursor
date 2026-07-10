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

/** Build config from environment with sane defaults; overrides win (tests use them). */
export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const base: GatewayConfig = {
    // Loopback-only: the gateway never binds a routable address (§1, §5).
    host: process.env.GATEWAY_HOST ?? "127.0.0.1",
    port: toInt(process.env.GATEWAY_PORT, 8000),
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
