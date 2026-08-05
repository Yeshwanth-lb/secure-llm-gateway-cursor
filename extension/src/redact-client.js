// ===== REDACT CLIENT — browser -> local gateway POST /redact ===============
// Thin fetch wrapper the content script uses to redact prompt text via the
// EXISTING, unchanged Phase L endpoint. Returns a normalized result the pure
// core (interceptor-core.decideSubmission) can act on.
//
// Design ref: scripts/gemini_imp.md §4.3 (endpoint reused as-is, no map).
// The raw text travels only browser -> 127.0.0.1 -> browser (same machine).

/** Build the /redact URL from a gateway base (default loopback:8001). */
export function redactUrl(base) {
  return `${(base || "http://127.0.0.1:8001").replace(/\/+$/, "")}/redact`;
}

/**
 * Read the admin surface config (mode/enabled) for enforcement. Loopback-gated
 * GET, no auth (same trust boundary as /redact). Returns null on any failure so
 * the caller keeps its current policy rather than flipping on a transient error —
 * enforcement must never DROP to unprotected because a poll missed.
 *
 * @param {string} surface  one of gemini|chatgpt|grok|deepseek
 * @param {{base?:string, timeoutMs?:number, fetchImpl?:typeof fetch}} [opts]
 */
export async function getSurfaceConfig(surface, opts = {}) {
  const base = (opts.base || "http://127.0.0.1:8001").replace(/\/+$/, "");
  const doFetch = opts.fetchImpl || fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 3000);
  try {
    const res = await doFetch(`${base}/internal/config/${encodeURIComponent(surface)}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    return { enabled: j.enabled !== false, mode: typeof j.mode === "string" ? j.mode : "redact" };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Ask the local gateway to redact `text`.
 * Resolves to { ok, redacted, piiDetected, matched } — `ok:false` means the
 * gateway was unreachable / errored (caller MUST fail closed; see
 * decideSubmission). Never throws.
 *
 * @param {string} text
 * @param {{base?:string, timeoutMs?:number, fetchImpl?:typeof fetch}} [opts]
 */
export async function redact(text, opts = {}) {
  const url = redactUrl(opts.base);
  const doFetch = opts.fetchImpl || fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 4000);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // audit:false — the send-time redaction must NOT create its own log row.
      // The full turn (prompt + assistant output) is logged once via /log-turn
      // after the response arrives, so there's exactly one row per turn.
      body: JSON.stringify({ text, source: "gemini-web-extension", audit: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false };
    const json = await res.json();
    return {
      ok: true,
      redacted: typeof json.redacted === "string" ? json.redacted : text,
      piiDetected: !!json.piiDetected,
      matched: json.matched || {},
    };
  } catch {
    // Network error, timeout, gateway down -> fail closed at the caller.
    return { ok: false };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Log a completed chat turn (redacted prompt + assistant response) to the
 * gateway so the Traffic Inspector shows it like a Claude turn. Fire-and-forget;
 * never throws. The gateway redacts both sides server-side and stores only
 * redacted text.
 *
 * `provider`/`source` identify the surface (site-adapter.js supplies them):
 * Gemini defaults, ChatGPT sends `provider:"openai"` +
 * `source:"chatgpt-web-extension"`. Both are existing `/log-turn` parameters —
 * the gateway is unchanged.
 *
 * @param {{prompt:string, response:string, model?:string, provider?:string, source?:string}} turn
 * @param {{base?:string, timeoutMs?:number, fetchImpl?:typeof fetch}} [opts]
 */
export async function logTurn(turn, opts = {}) {
  const url = `${(opts.base || "http://127.0.0.1:8001").replace(/\/+$/, "")}/log-turn`;
  const doFetch = opts.fetchImpl || fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 4000);
  try {
    await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: String(turn.prompt || ""),
        response: String(turn.response || ""),
        model: turn.model || "gemini",
        provider: turn.provider || "gemini",
        source: turn.source || "gemini-web-extension",
        // An UNSCANNED attachment (upload policy "warn") reached the model
        // without passing the PII gate. Same flag the Cursor bypass audits use,
        // so the Inspector shows the existing `unchecked` pill.
        ...(turn.unchecked === true ? { unchecked: true } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch {
    /* best-effort logging — never blocks the user */
  } finally {
    clearTimeout(t);
  }
}
