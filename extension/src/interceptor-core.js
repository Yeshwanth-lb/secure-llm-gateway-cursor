// ===== INTERCEPTOR CORE — pure control logic (no DOM, no fetch) ============
// The tricky, failure-prone decisions of the Gemini redaction extension live
// here as pure functions so they can be unit-tested headlessly (node --test),
// with zero browser. The DOM/fetch glue (content-main.js, composer.js,
// redact-client.js) calls into this; this file touches neither.
//
// Design ref: scripts/gemini_imp.md §4.1, §7 risks 1-3. The single most
// important thing this file guarantees is the LOOP GUARD (risk 2): our own
// programmatic re-submit must NOT be re-intercepted by our own listener, or we
// loop / double-redact. See createInterceptor().shouldIntercept + runResubmit.

/** Stamp applied to the synthetic re-submit event so we recognize our own. */
export const SYNTHETIC = Symbol("gemini-redact-synthetic");

/**
 * Create an interceptor guard instance. One per tab/content-script.
 * Stateful only in the private `resubmitting` flag; everything else is pure.
 */
export function createInterceptor() {
  // True only for the brief window while WE are re-dispatching a redacted
  // submit. The capture-phase listener checks this before acting.
  let resubmitting = false;

  const api = {
    isResubmitting: () => resubmitting,

    /** Tag an event as our own synthetic re-submit (belt-and-suspenders with the flag). */
    markSynthetic(event) {
      try {
        event[SYNTHETIC] = true;
      } catch {
        /* frozen/exotic event — the resubmitting flag still covers us */
      }
      return event;
    },

    isSynthetic(event) {
      return !!(event && event[SYNTHETIC]);
    },

    /**
     * The core decision: should this submit event be intercepted + redacted?
     * Returns false (let it through) when:
     *   - we're mid-resubmit (our own event in flight)      -> LOOP GUARD
     *   - the event is our tagged synthetic re-submit         -> LOOP GUARD
     *   - the event is untrusted (isTrusted === false)        -> not a real user submit
     * Otherwise true (intercept, kill, redact, re-fire).
     */
    shouldIntercept(event) {
      if (resubmitting) return false;
      if (api.isSynthetic(event)) return false;
      if (event && event.isTrusted === false) return false;
      return true;
    },

    /**
     * Run the programmatic re-submit with the loop guard held for its full
     * duration. `fn` typically dispatches the synthetic event synchronously,
     * so the listener that fires during dispatch sees resubmitting === true and
     * bails. The flag is always cleared, even if `fn` throws.
     */
    async runResubmit(fn) {
      resubmitting = true;
      try {
        return await fn();
      } finally {
        resubmitting = false;
      }
    },
  };

  return api;
}

/**
 * Decide what to do after calling the gateway. Pure. FAIL-CLOSED: if the
 * gateway was not reachable / did not answer 200 (`ok === false`), the message
 * must NOT be sent in any form — the user is told why. Otherwise submit the
 * redacted text (which equals the original when there was no PII).
 *
 * @param {{ok:boolean, redacted?:string, piiDetected?:boolean, originalText:string}} r
 * @returns {{action:"submit", text:string} | {action:"block", reason:string}}
 */
export function decideSubmission(r) {
  if (!r || r.ok !== true) {
    return { action: "block", reason: "gateway-unreachable" };
  }
  // When ok, `redacted` is authoritative. For clean text the gateway echoes it
  // unchanged; for PII it is the tokenized form. Never fall back to raw on ok.
  const text = typeof r.redacted === "string" ? r.redacted : r.originalText;
  return { action: "submit", text };
}
