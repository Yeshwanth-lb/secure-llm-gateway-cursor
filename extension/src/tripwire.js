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

import { GEMINI_ADAPTER, CHATGPT_ADAPTER, GROK_ADAPTER, DEEPSEEK_ADAPTER } from "./site-adapter.js";
import { isUploadUrl, uploadBlobsOf } from "./upload-core.js";

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
// Substrings that identify a site's prompt/generate request. Tunable, like the
// composer selectors — CONFIRM against the live Network tab and add the live
// substring if it drifts. Only requests matching one of these are inspected.
//
// The lists live with the rest of each site's knowledge in site-adapter.js (one
// source of truth, so adding a surface can't leave the tripwire behind). The
// detection itself — bodyLooksRaw, Luhn, the fetch/XHR wrapping — is site-
// agnostic and unchanged.
export const DEFAULT_GEMINI_ENDPOINTS = GEMINI_ADAPTER.tripwireEndpoints;
export const DEFAULT_CHATGPT_ENDPOINTS = CHATGPT_ADAPTER.tripwireEndpoints;
export const DEFAULT_GROK_ENDPOINTS = GROK_ADAPTER.tripwireEndpoints;
// DeepSeek NOTE: its request body is encrypted (WASM proof-of-work), so this list
// is best-effort there — the tripwire cannot read a ciphertext body. The composer
// intercept is the real protection on DeepSeek. Listed anyway: harmless, and it
// covers the case DeepSeek ever ships a plaintext body. See site-adapter.js.
export const DEFAULT_DEEPSEEK_ENDPOINTS = DEEPSEEK_ADAPTER.tripwireEndpoints;
// The default when a caller doesn't scope by site: the union, so a request is
// inspected on whichever surface it appears. Cross-site fragments simply never
// match (a Gemini fragment can't occur in a ChatGPT URL), and content-main.js
// passes its own site's list anyway.
export const DEFAULT_ENDPOINTS = [
  ...DEFAULT_GEMINI_ENDPOINTS,
  ...DEFAULT_CHATGPT_ENDPOINTS,
  ...DEFAULT_GROK_ENDPOINTS,
  ...DEFAULT_DEEPSEEK_ENDPOINTS,
];

/** True only if `url` looks like a generate endpoint we should inspect. */
export function shouldInspectUrl(url, endpoints = DEFAULT_ENDPOINTS) {
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
  const endpoints = opts.endpoints || DEFAULT_ENDPOINTS;
  // File uploads are a SEPARATE list: the bytes may go to a different host
  // entirely (`<region>.oaiusercontent.com`) and are carried as a Blob or as
  // multipart FormData rather than a string. Empty unless the surface has been
  // probed, so nothing changes for Gemini.
  const uploadEndpoints = opts.uploadEndpoints || [];
  const notify = (reason) => {
    try {
      win.dispatchEvent(new CustomEvent("gemini-redact:blocked", { detail: { reason } }));
    } catch {
      /* non-fatal */
    }
  };

  /**
   * Read every file-bearing part of an upload body and report whether any of them
   * contains raw PII. Shared by the fetch and XHR backstops.
   *
   * A read failure resolves to `false` (send it): this is a BACKSTOP whose
   * contract is "abort when raw PII is SEEN", and the attach-time guard has
   * already refused anything it could not read. Note the inherent ceiling — a
   * genuinely binary body (an image) reads as garbage no rule matches, so uploads
   * of unscannable formats can only be stopped at attach time, never here.
   */
  async function uploadLooksRaw(blobs) {
    for (const blob of blobs) {
      let text;
      try {
        text = await blob.text();
      } catch {
        continue;
      }
      if (bodyLooksRaw(text)) return true;
    }
    return false;
  }

  const origFetch = win.fetch;
  if (typeof origFetch === "function") {
    win.fetch = function (input, init) {
      // UPLOAD backstop, fetch side. ChatGPT PUTs its files over XHR, so this
      // branch did not exist until Grok — which POSTs multipart FormData with
      // `fetch` to /http/upload-file-v2/direct (probed live 2026-07-31). Without
      // it, Grok's uploads have no wire-level net at all whatever the body shape.
      //
      // Inspecting means an async read, and unlike XHR.send that costs nothing
      // here: fetch already returns a promise, so the read is simply awaited
      // before delegating. The request still goes out (or doesn't) exactly once.
      try {
        if (uploadEndpoints.length) {
          const body = init && init.body;
          const blobs = uploadBlobsOf(body);
          if (blobs.length && isUploadUrl(extractUrl(input), uploadEndpoints)) {
            const self = this;
            const args = arguments;
            return uploadLooksRaw(blobs).then((raw) => {
              if (raw) {
                console.error("[gemini-redact] tripwire: raw PII in outgoing file upload — aborting");
                notify("tripwire-upload");
                throw new Error("blocked by PII tripwire");
              }
              return origFetch.apply(self, args);
            });
          }
        }
      } catch {
        /* inspection failure is non-fatal — primary DOM path already ran */
      }
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
        // UPLOAD backstop. The body is a Blob/File, so inspecting it means an
        // ASYNC read — which is why `send()` is DEFERRED here instead of
        // inspected inline. The request still goes out (or doesn't) exactly once;
        // it just starts a tick later.
        //
        // Read failure passes the request through: this is a BACKSTOP whose
        // contract is "abort when raw PII is SEEN". The attach-time guard
        // (upload-guard.js) is the primary gate and has already refused anything
        // it could not read. Note the inherent ceiling — a genuinely binary body
        // (an image) reads as garbage that no rule matches, so uploads of
        // unscannable formats can only be stopped at attach time, never here.
        try {
          const blobs = uploadEndpoints.length ? uploadBlobsOf(body) : [];
          if (blobs.length && isUploadUrl(this.__geminiRedactUrl || "", uploadEndpoints)) {
            const self = this;
            const args = arguments;
            // `uploadBlobsOf` also unpacks multipart, so a surface that switched
            // from a raw PUT to FormData over XHR stays covered.
            uploadLooksRaw(blobs).then((raw) => {
              if (raw) {
                console.error("[gemini-redact] tripwire: raw PII in outgoing file upload — aborting");
                notify("tripwire-upload");
                try {
                  self.dispatchEvent(new ProgressEvent("error"));
                } catch {
                  /* the abort is the not-sending; the event is a courtesy */
                }
                return;
              }
              origSend.apply(self, args);
            });
            return;
          }
        } catch {
          /* fall through to the normal path */
        }
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
