// ===== TRIPWIRE (MAIN world) — secondary fail-closed net ===================
// BACKUP net. The primary mechanism is DOM interception (content-main.js): it
// redacts cleanly and preserves normal UX. This wraps fetch/XHR in the page and,
// if an outgoing request to Gemini's GENERATE endpoint STILL contains raw PII
// (i.e. the DOM rewrite somehow missed a path — e.g. after a Google UI change),
// aborts the request rather than letting it leave the machine. It cannot rewrite
// the body (MV3), only block — so on a broken DOM path the failure mode becomes
// "send blocked", never "raw leaked".
//
// PRODUCTION HARDENING (Phase G4): two changes made this safe to ship ON:
//   1. ENDPOINT SCOPING — only requests whose URL matches Gemini's generate
//      endpoint are inspected. Google's own telemetry/analytics/image traffic is
//      never touched, which is what previously caused false aborts of host
//      traffic (§7.7). The endpoint list is tunable (like the composer selectors)
//      and MUST be confirmed against the live Network tab — it can drift.
//   2. LUHN on cards — a 13–19 digit run is only treated as a card if it passes
//      the Luhn checksum, mirroring the gateway (src/redaction.ts luhnValid).
//      This removes the analytics-ID false positives.
//
// KNOWN BLIND SPOT (§7 risk 5): requests dispatched from the extension's
// background Service Worker are NOT visible to this page-world wrapper. That is
// deliberate and harmless here — our OWN gateway calls (/redact, /log-turn) go
// via the SW, so they can never self-trip this net; and DOM interception, not the
// tripwire, is the primary coverage. Do not treat a green tripwire as proof of
// full coverage.
//
// Design ref: scripts/gemini_imp.md §4.4, §6 Stage 4, §7 risk 5; REBUILD_PLAYBOOK §3.7.

// --- Luhn (mirrors src/redaction.ts luhnValid) ------------------------------
/** Luhn checksum — a candidate digit run is a card only if this passes. */
export function luhnValid(digits) {
  const d = String(digits).replace(/\D/g, "");
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

// --- Raw-PII patterns (aligned to the gateway's default rule sources) --------
// Non-card shapes are specific enough to match directly. The card is handled
// separately so it can be Luhn-gated (a bare digit-run regex false-positives on
// analytics IDs). Kept in-page so the wrapper stays synchronous (no await in the
// request path).
const NON_CARD_PII = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // EMAIL
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}=*/, // JWT
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/, // PEM key
];
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g; // 13–19 digits, then Luhn-gate

/**
 * Does this body still contain RAW (un-redacted) PII? True for a real
 * email/SSN/JWT/PEM key, or a digit run that passes Luhn (a real card). A
 * non-Luhn digit run (analytics id, order number) is NOT PII and returns false.
 */
export function bodyLooksRaw(body) {
  if (typeof body !== "string" || body === "") return false;
  if (NON_CARD_PII.some((re) => re.test(body))) return true;
  CARD_CANDIDATE.lastIndex = 0;
  let m;
  while ((m = CARD_CANDIDATE.exec(body)) !== null) {
    if (m[0] === "") {
      CARD_CANDIDATE.lastIndex++;
      continue;
    }
    if (luhnValid(m[0])) return true;
  }
  return false;
}

// --- Endpoint scoping -------------------------------------------------------
// Substrings that identify Gemini's prompt/generate request. Tunable, like the
// composer selectors — CONFIRM against the live Network tab and add the live
// substring if it drifts. Only requests matching one of these are inspected.
export const DEFAULT_GEMINI_ENDPOINTS = [
  // gemini.google.com (Bard web server)
  "/BardChatUi/",
  "StreamGenerate",
  "assistant.lamda",
  "BardFrontendService",
  "batchexecute",
  // Google Workspace side panel (Gmail/Docs/Sheets/Slides/Chat) — verified live
  // 2026-07-21: the generate call is lowercase `streamGenerate` on the
  // appsgenaiservice host. `includes` is case-sensitive, so the lowercase form
  // must be listed explicitly (the capitalized Bard one above does NOT match it).
  "streamGenerate",
  "appsgenaiservice",
];

/** True only if `url` looks like a Gemini generate endpoint we should inspect. */
export function shouldInspectUrl(url, endpoints = DEFAULT_GEMINI_ENDPOINTS) {
  if (typeof url !== "string" || url === "") return false;
  return endpoints.some((frag) => url.includes(frag));
}

/** Extract a string URL from a fetch input (string | URL | Request). */
export function extractUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    if (typeof input.url === "string") return input.url; // Request
    try {
      return String(input); // URL
    } catch {
      return "";
    }
  }
  return "";
}

// --- Installation -----------------------------------------------------------
/**
 * Wrap `win.fetch` and `win.XMLHttpRequest` so that a request to a Gemini
 * generate endpoint whose body still contains raw PII is ABORTED (fail-closed).
 * Off-endpoint traffic is passed straight through untouched.
 *
 * @param {any} win  the window (or a fake in tests)
 * @param {{endpoints?: string[]}} [opts]
 */
export function installTripwire(win = window, opts = {}) {
  const endpoints = opts.endpoints || DEFAULT_GEMINI_ENDPOINTS;
  const notify = (reason) => {
    try {
      win.dispatchEvent(new CustomEvent("gemini-redact:blocked", { detail: { reason } }));
    } catch {
      /* non-fatal */
    }
  };

  const origFetch = win.fetch;
  if (typeof origFetch === "function") {
    win.fetch = function (input, init) {
      try {
        const url = extractUrl(input);
        if (shouldInspectUrl(url, endpoints)) {
          const body = init && init.body;
          if (bodyLooksRaw(typeof body === "string" ? body : "")) {
            console.error("[gemini-redact] tripwire: raw PII in outgoing fetch body — aborting");
            notify("tripwire-fetch");
            return Promise.reject(new Error("blocked by PII tripwire"));
          }
        }
      } catch {
        /* inspection failure is non-fatal — primary DOM path already ran */
      }
      return origFetch.apply(this, arguments);
    };
  }

  const XHR = win.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    // Capture the URL at open() time so send() can scope the inspection.
    if (typeof XHR.prototype.open === "function") {
      const origOpen = XHR.prototype.open;
      XHR.prototype.open = function (method, url) {
        try {
          this.__geminiRedactUrl = typeof url === "string" ? url : extractUrl(url);
        } catch {
          this.__geminiRedactUrl = "";
        }
        return origOpen.apply(this, arguments);
      };
    }
    if (typeof XHR.prototype.send === "function") {
      const origSend = XHR.prototype.send;
      XHR.prototype.send = function (body) {
        try {
          if (shouldInspectUrl(this.__geminiRedactUrl || "", endpoints)) {
            if (bodyLooksRaw(typeof body === "string" ? body : "")) {
              console.error("[gemini-redact] tripwire: raw PII in outgoing XHR body — aborting");
              notify("tripwire-xhr");
              throw new Error("blocked by PII tripwire");
            }
          }
        } catch (e) {
          if (e && /blocked by PII tripwire/.test(e.message)) throw e;
          /* inspection failure is non-fatal */
        }
        return origSend.apply(this, arguments);
      };
    }
  }
}
