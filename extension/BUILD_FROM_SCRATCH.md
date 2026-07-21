# Gemini PII-Redaction Extension — Complete Build From Scratch

**One self-contained reference.** Everything needed to rebuild the entire
extension: the architecture, every file's full source with why it exists, the
manifest, the gateway endpoints it depends on, the tests, and how to load +
verify. If you have only this file, you can rebuild the whole thing.

Companion docs (optional): [`REBUILD_PLAYBOOK.md`](./REBUILD_PLAYBOOK.md) (the
blocker list), [`README.md`](./README.md) (user-facing), and
[`../scripts/gemini_imp.md`](../scripts/gemini_imp.md) (original design rationale).

---

## 1. What it does (30 seconds)

A Chrome MV3 extension for `gemini.google.com`. On every send it:

1. **Kills** the user's original submit (the raw text never leaves).
2. Sends the text to a **local redaction gateway** (`127.0.0.1:8001`, `POST /redact`).
3. Writes the **redacted** text back into the composer.
4. **Re-fires** a fresh submit with the redacted text.
5. After the reply settles, **logs the turn** (`POST /log-turn`) for the console.

Plus a **fail-closed tripwire**: a DOM-independent net that aborts any outgoing
Gemini request whose body still contains raw PII (survives Gemini UI changes).

**One-way:** redaction is permanent — no restore. Sent bubble + replies show
`[REDACTED_PII_EMAIL]`-style tokens. **Fail-closed:** any uncertainty blocks the
send, never leaks.

---

## 2. Why an extension (not a gateway like Claude/Cursor)

The loopback-gateway trick (point the client at `127.0.0.1`) can't work for
Gemini web: the browser sends prompts from **Google's servers**, so there's no
on-machine request to intercept, and MV3 **forbids** rewriting request bodies.
The only local interception point is the **DOM inside the page.**

---

## 3. The four-world model (the thing to understand first)

MV3 splits code across contexts that **cannot share variables**. Which world can
do what dictates the whole file layout:

| World | Sees Gemini's composer/events? | Can call `chrome.*`? | Can fetch the gateway? |
|-------|:---:|:---:|:---:|
| **MAIN** (page world) | ✅ | ❌ | ❌ (page CORS) |
| **ISOLATED** (content script) | DOM only | ✅ | ❌ (page CORS) |
| **Service Worker** (background) | ❌ | ✅ | ✅ (host_permissions) |

- Interception must run in **MAIN** (needs the composer + events).
- MAIN can't reach `chrome.*` → an **ISOLATED** bridge relays via DOM `CustomEvent`.
- Neither page world may fetch the gateway → the fetch lives in the **SW**.

**Redact-one-prompt data flow:**
```
MAIN (content-main) --CustomEvent--> ISOLATED (content-bridge)
  --chrome.runtime.sendMessage--> SW (background) --fetch--> 127.0.0.1 gateway
  --result back up the same chain-->
```
Raw text travels only browser → 127.0.0.1 → browser. Never to Google.

---

## 4. File map + build order

Build bottom-up (each layer testable before the next):

| # | File | World | Role |
|---|------|-------|------|
| 1 | `src/interceptor-core.js` | MAIN (pure) | Loop guard + fail-closed decision. Unit-tested. |
| 2 | `src/redact-client.js` | MAIN/SW | `fetch` wrappers for `/redact` + `/log-turn`. |
| 3 | `src/composer.js` | MAIN | Selector-fragile DOM read/write. |
| 4 | `src/tripwire.js` | MAIN | DOM-independent safety net (Luhn + endpoint-scoped). |
| 5 | `src/content-main.js` | MAIN | The glue: intercept → redact → re-fire → log. |
| 6 | `src/content-bridge.js` | ISOLATED | Config + message relay MAIN↔SW. |
| 7 | `src/loader.js` | ISOLATED | Injects the MAIN-world ES module. |
| 8 | `src/background.js` | SW | The only gateway fetch. |
| 9 | `manifest.json` | — | Wiring. |

---

## 5. Full source (verbatim)

### 5.1 `src/interceptor-core.js` — pure control logic

The genuinely tricky decisions (loop guard, fail-closed) live here as pure
functions so they're unit-testable with zero browser. **Loop guard** = our own
re-fired submit must not be re-caught.

```js
// ===== INTERCEPTOR CORE — pure control logic (no DOM, no fetch) ============
export const SYNTHETIC = Symbol("gemini-redact-synthetic");

export function createInterceptor() {
  let resubmitting = false;
  const api = {
    isResubmitting: () => resubmitting,
    markSynthetic(event) {
      try { event[SYNTHETIC] = true; } catch { /* frozen event — flag still covers us */ }
      return event;
    },
    isSynthetic(event) { return !!(event && event[SYNTHETIC]); },
    // Intercept a real user submit; skip our own re-submit (loop guard) and untrusted events.
    shouldIntercept(event) {
      if (resubmitting) return false;
      if (api.isSynthetic(event)) return false;
      if (event && event.isTrusted === false) return false;
      return true;
    },
    // Hold the guard for the whole re-submit so the listener firing during dispatch bails.
    async runResubmit(fn) {
      resubmitting = true;
      try { return await fn(); } finally { resubmitting = false; }
    },
  };
  return api;
}

// FAIL-CLOSED: gateway not ok -> block (never send raw). Otherwise send redacted.
export function decideSubmission(r) {
  if (!r || r.ok !== true) return { action: "block", reason: "gateway-unreachable" };
  const text = typeof r.redacted === "string" ? r.redacted : r.originalText;
  return { action: "submit", text };
}
```

### 5.2 `src/redact-client.js` — gateway fetch wrappers

Thin, never-throws wrappers. `redact()` sends `audit:false` (send-time redaction
must not create its own log row — the turn is logged once via `/log-turn`).

```js
// ===== REDACT CLIENT — browser -> local gateway ============================
export function redactUrl(base) {
  return `${(base || "http://127.0.0.1:8001").replace(/\/+$/, "")}/redact`;
}

export async function redact(text, opts = {}) {
  const url = redactUrl(opts.base);
  const doFetch = opts.fetchImpl || fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 4000);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    return { ok: false }; // network error/timeout/gateway down -> caller fails closed
  } finally {
    clearTimeout(t);
  }
}

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
```

### 5.3 `src/composer.js` — the selector-fragile DOM layer

All the browser-dependent, most-likely-to-break-on-a-UI-change logic. **The
critical function is `writeText`:** a bare `textContent = redacted` leaks raw
because Gemini's Quill editor sends from its own async Delta model, not the DOM —
so we drive the edit through `execCommand("insertText")` (see §7 risk in playbook).

```js
// ===== COMPOSER — DOM read/write for the Gemini prompt box =================
const COMPOSER_SELECTORS = [
  'div.ql-editor[contenteditable="true"]',  // Gemini uses a Quill-based editor (matched live 2026-07-20)
  'rich-textarea .ql-editor',
  'div[contenteditable="true"][role="textbox"]',
  'textarea[aria-label]',
];

export function findComposer(root = document) {
  for (const sel of COMPOSER_SELECTORS) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

export function readText(el) {
  if (!el) return "";
  if ("value" in el && typeof el.value === "string") return el.value; // textarea
  return el.textContent || ""; // contenteditable
}

// Write so the framework MODEL updates, not just the DOM (else stale raw submits).
export function writeText(el, text) {
  if (!el) return false;
  if ("value" in el && typeof el.value === "string") {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, text); else el.value = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return true;
  }
  // contenteditable (Quill): drive through the native input pipeline the editor listens to.
  try {
    el.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
    const ok = document.execCommand("insertText", false, text);
    if (ok) return true;
  } catch { /* fall through */ }
  el.textContent = text; // best-effort fallback
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  return true;
}

export function findSendButton(root = document) {
  return (
    root.querySelector('button.send-button') ||
    root.querySelector('button[aria-label*="Send" i]') ||
    root.querySelector('button[aria-label*="Submit" i]') ||
    root.querySelector('button[mattooltip*="Send" i]') ||
    root.querySelector('[data-test-id="send-button"], [data-testid*="send" i]') ||
    root.querySelector('button:has(mat-icon[fonticon="send"])') ||
    root.querySelector('button:has(mat-icon)') ||
    null
  );
}

const MODEL_SELECTORS = [
  '[data-test-id="bard-mode-menu-button"]',
  "bard-mode-switcher button",
  '[aria-label*="model" i] .logo-pill-label-container',
  ".logo-pill-label-container",
];

export function getModel(root = document) {
  for (const sel of MODEL_SELECTORS) {
    const el = root.querySelector(sel);
    const txt = el && (el.innerText || el.textContent || "").trim();
    if (txt) {
      const m = txt.match(/\b(flash|pro|ultra|nano|advanced|thinking)\b/i);
      if (m) return "gemini-" + m[1].toLowerCase();
    }
  }
  const hdr = (root.body && root.body.innerText) || "";
  const m = hdr.slice(0, 400).match(/\b(flash|pro|ultra|nano)\b/i);
  return m ? "gemini-" + m[1].toLowerCase() : "gemini";
}

const RESPONSE_SELECTORS = [
  "message-content .markdown",
  ".model-response-text .markdown",
  ".model-response-text",
  "message-content",
  ".response-container .markdown",
];

function resolveResponseEls(root) {
  for (const sel of RESPONSE_SELECTORS) {
    const els = root.querySelectorAll(sel);
    if (els.length) return els;
  }
  return [];
}

export function responseCount(root = document) { return resolveResponseEls(root).length; }

export function readLatestResponse(root = document) {
  const els = resolveResponseEls(root);
  if (!els.length) return "";
  const last = els[els.length - 1];
  return (last.innerText || last.textContent || "").trim();
}

// FAIL CLOSED if the composer selector breaks (disable sending, don't leak).
export function selectorsHealthy(root = document) {
  const composer = !!findComposer(root);
  const sendButton = !!findSendButton(root);
  return { healthy: composer, composer, sendButton };
}
```

### 5.4 `src/tripwire.js` — DOM-independent safety net (ON by default)

Wraps `fetch`/`XHR`. If a request to **Gemini's generate endpoint** still has raw
PII, it **aborts** (can't rewrite in MV3, only block). Two things make it safe to
ship ON: **endpoint scoping** (never touches Google's telemetry) + **Luhn** (a
digit run is a card only if it validates). This is what survives a Gemini UI change.

```js
// ===== TRIPWIRE (MAIN world) — secondary fail-closed net ===================
export function luhnValid(digits) {
  const d = String(digits).replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n; dbl = !dbl;
  }
  return sum % 10 === 0;
}

const NON_CARD_PII = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,                 // EMAIL
  /\b\d{3}-\d{2}-\d{4}\b/,                                          // SSN
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}=*/, // JWT
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/, // PEM key
];
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;                 // 13–19 digits, then Luhn-gate

export function bodyLooksRaw(body) {
  if (typeof body !== "string" || body === "") return false;
  if (NON_CARD_PII.some((re) => re.test(body))) return true;
  CARD_CANDIDATE.lastIndex = 0;
  let m;
  while ((m = CARD_CANDIDATE.exec(body)) !== null) {
    if (m[0] === "") { CARD_CANDIDATE.lastIndex++; continue; }
    if (luhnValid(m[0])) return true;
  }
  return false;
}

// Substrings identifying Gemini's generate request. TUNABLE — confirm live.
export const DEFAULT_GEMINI_ENDPOINTS = [
  "/BardChatUi/", "StreamGenerate", "assistant.lamda", "BardFrontendService", "batchexecute",
];

export function shouldInspectUrl(url, endpoints = DEFAULT_GEMINI_ENDPOINTS) {
  if (typeof url !== "string" || url === "") return false;
  return endpoints.some((frag) => url.includes(frag));
}

export function extractUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    if (typeof input.url === "string") return input.url; // Request
    try { return String(input); } catch { return ""; }  // URL
  }
  return "";
}

export function installTripwire(win = window, opts = {}) {
  const endpoints = opts.endpoints || DEFAULT_GEMINI_ENDPOINTS;
  const notify = (reason) => {
    try { win.dispatchEvent(new CustomEvent("gemini-redact:blocked", { detail: { reason } })); }
    catch { /* non-fatal */ }
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
      } catch { /* inspection failure non-fatal — DOM path already ran */ }
      return origFetch.apply(this, arguments);
    };
  }

  const XHR = win.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    if (typeof XHR.prototype.open === "function") {
      const origOpen = XHR.prototype.open;
      XHR.prototype.open = function (method, url) {
        try { this.__geminiRedactUrl = typeof url === "string" ? url : extractUrl(url); }
        catch { this.__geminiRedactUrl = ""; }
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
          /* inspection failure non-fatal */
        }
        return origSend.apply(this, arguments);
      };
    }
  }
}
```

> **SW blind spot (intentional):** the tripwire runs in MAIN, so it can't see the
> SW's own `/redact` + `/log-turn` fetches — which means it can never self-trip.
> DOM interception, not the tripwire, is the primary coverage.

### 5.5 `src/content-main.js` — the glue (MAIN world)

Registers capture-phase listeners on `document`, kills the real submit, redacts
via the bridge→SW, writes the redacted text, **yields a macrotask** (so Quill's
Delta absorbs it — else stale raw sends), re-fires with the loop guard held, then
logs the turn.

```js
// ===== CONTENT SCRIPT (MAIN world) — intercept, redact, re-submit ==========
import { createInterceptor, decideSubmission } from "./interceptor-core.js";
import { findComposer, readText, writeText, findSendButton, selectorsHealthy,
         getModel, readLatestResponse, responseCount } from "./composer.js";
import { installTripwire } from "./tripwire.js";

// Redact via the isolated bridge -> background SW (fetch can't happen in MAIN; CORS).
function requestRedaction(text, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
    const onResp = (e) => { if (!e.detail || e.detail.id !== id) return; cleanup(); resolve(e.detail.result || { ok: false }); };
    const timer = setTimeout(() => { cleanup(); resolve({ ok: false }); }, timeoutMs);
    function cleanup() { clearTimeout(timer); window.removeEventListener("gemini-redact:redact-response", onResp); }
    window.addEventListener("gemini-redact:redact-response", onResp);
    window.dispatchEvent(new CustomEvent("gemini-redact:redact-request", { detail: { id, text } }));
  });
}

const ix = createInterceptor();

// tripwire ON by default (Phase G4): endpoint-scoped + Luhn, so no telemetry
// false-positives. It's the fail-closed net if the DOM path breaks on a UI change.
let CONFIG = { base: "http://127.0.0.1:8001", enabled: true, tripwire: true, debug: false };
let tripwireInstalled = false;
function applyTripwire() {
  if (CONFIG.tripwire && !tripwireInstalled) {
    installTripwire(window, CONFIG.tripwireEndpoints ? { endpoints: CONFIG.tripwireEndpoints } : {});
    tripwireInstalled = true;
  }
}
window.addEventListener("gemini-redact:config", (e) => {
  if (e && e.detail && typeof e.detail === "object") CONFIG = { ...CONFIG, ...e.detail };
  applyTripwire();
});

function notifyBlocked(reason) {
  const msg =
    reason === "gateway-unreachable"
      ? "PII gateway unreachable — message blocked (fail-closed). Start the local gateway and retry."
      : reason === "selectors-broken"
        ? "Redaction extension can't find the composer (Gemini UI may have changed) — sending disabled to avoid leaking PII."
        : "Message blocked by PII redaction policy.";
  console.warn("[gemini-redact]", msg);
  try { window.dispatchEvent(new CustomEvent("gemini-redact:blocked", { detail: { reason, msg } })); } catch { /* non-fatal */ }
}

async function onSubmitEvent(event) {
  if (!CONFIG.enabled) return;
  if (!ix.shouldIntercept(event)) return; // our own re-submit / synthetic / untrusted -> let through

  const composer = findComposer();
  if (!composer) { event.preventDefault(); event.stopImmediatePropagation(); notifyBlocked("selectors-broken"); return; }

  const text = readText(composer);
  if (text.trim() === "") return; // empty can't leak

  // KILL the original fully — we can't pause/resume it across the async gateway call.
  event.preventDefault();
  event.stopImmediatePropagation();

  const result = await requestRedaction(text);
  const decision = decideSubmission({ ...result, originalText: text });
  if (decision.action === "block") { notifyBlocked(decision.reason); return; }

  writeText(composer, decision.text);

  // CRITICAL: yield so Quill's async Delta absorbs our change before we re-fire,
  // else Gemini submits the STALE (raw) model even though the DOM shows the token.
  await new Promise((r) => setTimeout(r, 120));

  await ix.runResubmit(async () => { fireSubmit(composer); });

  captureAndLogTurn(text); // log the raw prompt; gateway redacts server-side before storing
}

function captureAndLogTurn(rawPrompt) {
  const model = getModel();
  const baseline = responseCount(); // only capture a NEW reply node past this
  let settleTimer = null, done = false;
  const finish = () => {
    if (done) return; done = true;
    try { obs.disconnect(); } catch { /* ignore */ }
    clearTimeout(hardTimeout);
    const response = responseCount() > baseline ? readLatestResponse() : "";
    window.dispatchEvent(new CustomEvent("gemini-redact:log-turn", { detail: { prompt: rawPrompt, response, model } }));
  };
  const obs = new MutationObserver(() => {
    if (responseCount() <= baseline) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(finish, 2500); // quiet 2.5s after new node = reply done
  });
  try { obs.observe(document.body, { childList: true, subtree: true, characterData: true }); }
  catch { /* hard timeout still logs */ }
  const hardTimeout = setTimeout(finish, 30000);
}

function fireSubmit(composer) {
  const btn = findSendButton();
  if (btn) { btn.dispatchEvent(ix.markSynthetic(new MouseEvent("click", { bubbles: true, cancelable: true }))); return; }
  composer.dispatchEvent(ix.markSynthetic(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })));
}

// Register HIGH + CAPTURE so we run before Gemini's own handlers.
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) onSubmitEvent(e); }, true);
document.addEventListener("click", (e) => {
  const el = e.target;
  if (el && el.closest && el.closest('button[aria-label*="Send" i], button[aria-label*="Submit" i], button[data-testid*="send" i]')) onSubmitEvent(e);
}, true);

// Health check: selectors broke -> fail closed.
setInterval(() => { const h = selectorsHealthy(); if (!h.healthy) notifyBlocked("selectors-broken"); }, 15000);

console.info("[gemini-redact] content script active (MAIN world)");
```

### 5.6 `src/content-bridge.js` — config + message relay (ISOLATED world)

Relays config from `chrome.storage` (managed > local) into MAIN, and relays
redact/log messages MAIN → SW → MAIN. No PII crosses here beyond the relay.

```js
// ===== CONTENT SCRIPT (ISOLATED world) — config bridge =====================
const DEFAULTS = { base: "http://127.0.0.1:8001", enabled: true };
const CONFIG_KEYS = ["base", "enabled", "tripwire", "tripwireEndpoints"];

function push(cfg) { window.dispatchEvent(new CustomEvent("gemini-redact:config", { detail: cfg })); }

function load() {
  const store = (globalThis.chrome && chrome.storage) || null;
  if (!store) { push(DEFAULTS); return; }
  const areas = [store.managed, store.local].filter(Boolean);
  Promise.all(areas.map((a) => new Promise((res) => a.get(CONFIG_KEYS, (v) => res(v || {}))))).then((results) => {
    const merged = Object.assign({}, DEFAULTS, results[1] || {}, stripUndefined(results[0] || {})); // managed wins
    push(merged);
  });
}
function stripUndefined(o) { const out = {}; for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k]; return out; }

// Relay redaction MAIN -> background SW (only the SW may fetch the gateway).
window.addEventListener("gemini-redact:redact-request", (e) => {
  const { id, text } = (e && e.detail) || {};
  const respond = (result) => window.dispatchEvent(
    new CustomEvent("gemini-redact:redact-response", { detail: { id, result: result || { ok: false } } }));
  if (!(globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage)) { respond({ ok: false }); return; }
  try { chrome.runtime.sendMessage({ type: "redact", text }, (result) => respond(result)); }
  catch { respond({ ok: false }); }
});

// Relay per-turn logging MAIN -> background (fire-and-forget).
window.addEventListener("gemini-redact:log-turn", (e) => {
  const turn = (e && e.detail) || {};
  if (!(globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage)) return;
  try { chrome.runtime.sendMessage({ type: "logTurn", turn }, () => void chrome.runtime.lastError); } catch { /* non-fatal */ }
});

// Surface fail-closed blocks to the extension (badge/toast if wired later).
window.addEventListener("gemini-redact:blocked", (e) => {
  if (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage) {
    try { chrome.runtime.sendMessage({ type: "blocked", detail: e.detail }); } catch { /* non-fatal */ }
  }
});

load();
if (globalThis.chrome && chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(load);
```

### 5.7 `src/loader.js` — inject the MAIN-world module (ISOLATED world)

MV3 content scripts can't `import`, so this injects a `<script type="module">`
pointing at the web-accessible `content-main.js`, which then runs in MAIN.

```js
// ===== LOADER (ISOLATED world) — inject the MAIN-world ES module ===========
(function injectMain() {
  try {
    const url = chrome.runtime.getURL("src/content-main.js");
    const s = document.createElement("script");
    s.type = "module";
    s.src = url;
    s.dataset.geminiRedact = "1";
    (document.head || document.documentElement).appendChild(s); // document_start: head may not exist
    s.addEventListener("load", () => s.remove());
  } catch (e) {
    console.error("[gemini-redact] loader failed to inject MAIN module:", e);
    window.dispatchEvent(new CustomEvent("gemini-redact:blocked", { detail: { reason: "loader-failed" } }));
  }
})();
```

### 5.8 `src/background.js` — the only gateway fetch (Service Worker)

Page-world fetch to `127.0.0.1` is CORS-blocked; the SW has `host_permissions`
and is not subject to page CORS. All gateway calls funnel here.

```js
// ===== BACKGROUND SERVICE WORKER — the ONLY component that may fetch the gateway
import { redact, logTurn } from "./redact-client.js";

let CONFIG = { base: "http://127.0.0.1:8001" };

function loadConfig() {
  if (!(globalThis.chrome && chrome.storage)) return;
  const areas = [chrome.storage.managed, chrome.storage.local].filter(Boolean);
  Promise.all(areas.map((a) => new Promise((res) => a.get(["base"], (v) => res(v || {}))))).then(([managed, local]) => {
    CONFIG = { base: (managed && managed.base) || (local && local.base) || CONFIG.base };
  });
}
loadConfig();
if (globalThis.chrome && chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(loadConfig);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "redact" && typeof msg.text === "string") {
    redact(msg.text, { base: CONFIG.base }).then(sendResponse); // never throws; {ok:false} on failure
    return true; // keep channel open for async response
  }
  if (msg && msg.type === "logTurn" && msg.turn) {
    logTurn(msg.turn, { base: CONFIG.base }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
```

### 5.9 `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "Gemini PII Redaction (local gateway)",
  "version": "0.1.0",
  "description": "Best-effort, fail-closed PII redaction for gemini.google.com. Rewrites prompts through the local redaction gateway before they leave the browser. One-way: values are not restored.",
  "minimum_chrome_version": "111",
  "permissions": ["storage"],
  "host_permissions": ["http://127.0.0.1:8001/*", "http://127.0.0.1:8000/*"],
  "background": { "service_worker": "src/background.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["https://gemini.google.com/*"],
      "js": ["src/content-bridge.js", "src/loader.js"],
      "run_at": "document_start",
      "world": "ISOLATED"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["src/content-main.js", "src/interceptor-core.js", "src/composer.js", "src/tripwire.js"],
      "matches": ["https://gemini.google.com/*"]
    }
  ]
}
```

**Why each key:** `host_permissions` loopback-only = the SW can fetch the gateway
without page CORS. `world: ISOLATED` + `document_start` = the bridge/loader run
early with `chrome.*` access. Every MAIN import must be in
`web_accessible_resources` or the module load 404s (→ fail closed).

---

## 6. Gateway contract (backend — reused UNCHANGED)

The extension depends only on these loopback endpoints (`src/server.ts`). No
extension-specific backend was added.

| Endpoint | Method | Body | Returns | Notes |
|----------|--------|------|---------|-------|
| `/redact` | POST | `{text, source, audit:false}` | `{redacted, piiDetected, matched}` | Send-time redaction. `audit:false` → no log row (turn logged once via `/log-turn`). |
| `/log-turn` | POST | `{prompt, response, model, source}` | `{ok}` | Logs one `CHAT` row per turn. Send the **raw** prompt — gateway redacts server-side before storing (accurate PII flag, only redacted text persisted). |
| `/healthz` | GET | — | health | Optional health check. |

**CORS:** the gateway allows a `chrome-extension://` origin on `/detect`,
`/redact`, `/log-turn` only (`isExtensionOrigin` in `src/server.ts`). Do not widen
beyond these. Gateway runs on **8001** (not 8000).

---

## 7. Tests

Headless, part of `npm test` (pure logic — loop guard, fail-closed, tripwire
predicates). File: `tests/phase-gemini-core.test.ts`. The tripwire trio:

```js
import { bodyLooksRaw, shouldInspectUrl, installTripwire } from "../extension/src/tripwire.js";

// happy: redacted body on the Gemini endpoint is NOT aborted.
// failure: raw PII on the Gemini endpoint IS aborted (fetch + XHR) + blocked event.
// edge:   non-Luhn 16-digit run is not a card; off-endpoint telemetry is never inspected.
```
Drive `installTripwire` with a fake `win` (`{fetch, XMLHttpRequest, dispatchEvent}`)
— no browser, no new dep. Also: `npm run test:gemini-e2e` (Playwright, dev-only)
drives the real `content-main.js` in headless Chromium against a fake Gemini page
+ the real gateway (proves intercept/loop-guard/one-send/no-raw/fail-closed).

Run:
```
node --experimental-strip-types --test tests/phase-gemini-core.test.ts
npm test                # full suite (109/109 as of 2026-07-20)
npm run test:gemini-e2e # 8/8
```

---

## 8. Load + verify

1. Start the gateway: `npm run dev` (or the installed service), `127.0.0.1:8001`.
2. `chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`.
   *(Per Chrome profile — extensions don't follow accounts/profiles.)*
3. Open `gemini.google.com`; console shows `[gemini-redact] content script active (MAIN world)`.
4. **Definitive proof:** paste `pii-sample.txt` (regen: `node scripts/gen-pii-sample.mjs`),
   send. In the **Network** tab confirm only `[REDACTED_PII_*]` tokens, zero raw PII,
   exactly one request. Stop the gateway → send is **blocked** (fail-closed).
5. **Tripwire live check:** normal send's generate URL should match
   `DEFAULT_GEMINI_ENDPOINTS` (log it; add the substring if not); Google telemetry
   must NOT be aborted; break a selector in `composer.js` and confirm raw PII is
   then aborted by the tripwire (not leaked).

---

## 9. Invariants (don't regress)

- Raw text goes only browser ↔ 127.0.0.1. Never to Google, never persisted raw.
- **Fail closed** on every uncertainty. Erroring beats leaking.
- **One-way** redaction — no map, no restore. Gateway endpoint stays unchanged.
- Keep the hard logic pure/tested (`interceptor-core.js`); keep fragile DOM logic
  centralized (`composer.js`).
- Keep `writeText`'s native-pipeline write **and** the 120ms pre-refire yield.
- Never widen gateway CORS beyond the three hook endpoints for extension origins.
- Tripwire must stay Luhn-checked + endpoint-scoped before it's ON.

---

## 10. Porting (Chrome-only today)

- **Firefox:** `browser.*` (add `const api = globalThis.browser ?? globalThis.chrome`),
  `background.scripts` not `service_worker`. Re-verify MAIN-world inject.
- **Safari:** must ship inside a native app — `xcrun safari-web-extension-converter
  extension/` → Xcode → sign. Re-verify MAIN-world + SW behavior. Untested = new work.
```
