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
 * @param {{prompt:string, response:string, model?:string}} turn
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
        source: "gemini-web-extension",
      }),
      signal: ctrl.signal,
    });
  } catch {
    /* best-effort logging — never blocks the user */
  } finally {
    clearTimeout(t);
  }
}
