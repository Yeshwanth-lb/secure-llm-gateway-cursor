// ===== CONFIG ================================================================
import type { Provider } from "./contracts.ts";

export interface GatewayConfig {
  host: string;
  port: number;
  bodyCapBytes: number;
  streamHoldbackChars: number;
  /** Max chars kept per request/response snapshot in a log entry. 0 = unlimited. */
  snapshotChars: number;
  upstreams: Record<Provider, string>;
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
    host: process.env.GATEWAY_HOST ?? "127.0.0.1",
    port: toInt(process.env.GATEWAY_PORT, 8000),
    bodyCapBytes: toInt(process.env.MAX_BODY_BYTES, 25 * 1024 * 1024),
    streamHoldbackChars: toInt(process.env.STREAM_HOLDBACK_CHARS, 96),
    // default 256 KB — captures a full Claude Code turn incl. the trailing
    // `system` prompt. Set SNAPSHOT_CHARS=0 for unlimited (more memory).
    snapshotChars: toIntAllowZero(process.env.SNAPSHOT_CHARS, 262144),
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
