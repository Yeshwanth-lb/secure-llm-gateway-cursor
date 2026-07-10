// ===== ROUTING (Phase B1) — 5-tier provider resolution + header forwarding ===
// newplan.md §2. resolveRoute reads only req.url + req.headers so it stays pure
// and unit-testable. Contract note (agreed 2026-07-09): resolveRoute returns
// `RouteResult | null` — null means "no route" (server renders the 404 hint) —
// rather than throwing, since a missing route is normal control flow, not an error.
import type { IncomingMessage } from "node:http";
import type { Provider, RouteResult } from "./contracts.ts";
import { loadConfig } from "./config.ts";

/** Hop-by-hop / transport headers never forwarded upstream (newplan §2). */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "te",
  "upgrade",
]);

/** Gateway-only control headers — consumed here, never sent upstream. */
const CONTROL_HEADERS = new Set(["x-llm-provider", "x-llm-upstream"]);

const PREFIXES: [string, Provider][] = [
  ["/anthropic", "anthropic"],
  ["/gemini", "gemini"],
  ["/openai", "openai"],
];

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export interface ResolveRouteOptions {
  /** Honor `x-llm-upstream` only when true and target is loopback (§5). */
  allowUpstreamOverride?: boolean;
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost") return true;
    if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
    if (/^(?:0*:)*0*1$/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

function resolveOverride(
  override: string | undefined,
  opts: ResolveRouteOptions | undefined,
): string | undefined {
  if (!override || !opts?.allowUpstreamOverride) return undefined;
  return isLoopbackUrl(override) ? override : undefined;
}

function make(
  provider: Provider,
  upstreams: Record<Provider, string>,
  overrideBase: string | undefined,
  forwardPath: string,
): RouteResult {
  const base = (overrideBase ?? upstreams[provider]).replace(/\/+$/, "");
  const fwd = forwardPath.startsWith("/") ? forwardPath : "/" + forwardPath;
  return { provider, upstreamBase: base, forwardPath: fwd };
}

const OPENAI_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
  "/v1/responses",
]);

/**
 * Resolve the upstream provider for a request. First match wins (newplan §2):
 *   1 path prefix  2 x-llm-provider header  3 path heuristic  4 header sniff  5 none
 */
export function resolveRoute(
  req: IncomingMessage,
  upstreams: Record<Provider, string> = loadConfig().upstreams,
  opts: ResolveRouteOptions = {},
): RouteResult | null {
  const u = new URL(req.url ?? "/", "http://localhost");
  const path = u.pathname;
  const tail = path + u.search;
  const h = req.headers;
  const override = resolveOverride(firstHeader(h["x-llm-upstream"]), opts);

  // Tier 1 — explicit path prefix (stripped before forwarding).
  for (const [prefix, provider] of PREFIXES) {
    if (path === prefix || path.startsWith(prefix + "/")) {
      const stripped = tail.slice(prefix.length) || "/";
      return make(provider, upstreams, override, stripped);
    }
  }

  // Tier 2 — explicit provider header.
  const hinted = firstHeader(h["x-llm-provider"])?.toLowerCase();
  if (hinted === "anthropic" || hinted === "gemini" || hinted === "openai") {
    return make(hinted, upstreams, override, tail);
  }

  // Tier 3 — path heuristics.
  if (path === "/v1/messages" || path === "/v1/complete") {
    return make("anthropic", upstreams, override, tail);
  }
  if (
    path.startsWith("/v1beta") ||
    path.startsWith("/v1alpha") ||
    /:(?:generateContent|streamGenerateContent|countTokens)/.test(path)
  ) {
    return make("gemini", upstreams, override, tail);
  }
  if (OPENAI_PATHS.has(path)) {
    return make("openai", upstreams, override, tail);
  }

  // Tier 4 — header sniff (covers ambiguous paths like /v1/models).
  if (
    h["anthropic-version"] !== undefined ||
    h["anthropic-beta"] !== undefined ||
    h["x-api-key"] !== undefined
  ) {
    return make("anthropic", upstreams, override, tail);
  }
  if (h["x-goog-api-key"] !== undefined) {
    return make("gemini", upstreams, override, tail);
  }
  const auth = firstHeader(h["authorization"]);
  if (auth && /^Bearer\s/i.test(auth)) {
    // Claude Code Enterprise OAuth uses Bearer on Anthropic-shaped /v1/* paths.
    if (path.startsWith("/v1/") && !OPENAI_PATHS.has(path)) {
      return make("anthropic", upstreams, override, tail);
    }
    return make("openai", upstreams, override, tail);
  }

  // Tier 5 — no signal.
  return null;
}

/**
 * Build the header set forwarded upstream: copy verbatim except hop-by-hop and
 * gateway control headers; force `accept-encoding: identity` so response bodies
 * arrive uncompressed and inspectable. Auth headers pass through untouched.
 * `content-length` is intentionally omitted — the caller recomputes it after
 * redaction changes the body length.
 */
export function buildForwardHeaders(
  req: IncomingMessage,
  _route: RouteResult,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || CONTROL_HEADERS.has(lk) || lk.startsWith("proxy-")) {
      continue;
    }
    if (v === undefined) continue;
    out[lk] = Array.isArray(v) ? v.join(", ") : v;
  }
  out["accept-encoding"] = "identity";
  return out;
}
