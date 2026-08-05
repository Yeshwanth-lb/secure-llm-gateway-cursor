// ===== CONTENT SCRIPT (ISOLATED world) — config bridge =====================
// The MAIN-world script (content-main.js) can see the page but NOT extension
// APIs (api.storage). This isolated-world script has the opposite access, so
// it relays configuration (gateway URL, enabled toggle) into MAIN world via a
// DOM CustomEvent. No PII and no token map ever cross this bridge — there is no
// map in this design (rev.2), and prompt text never leaves the MAIN world.
//
// `api` is the Chrome/Firefox/Safari extension namespace resolved by
// browser-api.js, which the manifest lists immediately before this file.
//
// Design ref: scripts/gemini_imp.md §4.2.

const { api, storageGet, storageSet, sendMessage } = globalThis.geminiRedactBrowserApi;

/**
 * Hand a plain object to MAIN-world JS.
 *
 * Firefox keeps the content-script compartment separate from the page's, so an
 * object created HERE is opaque to the page — reading a property throws
 * "Permission denied to access property". Chrome and Safari share objects across
 * worlds directly. Without this, content-main.js could not read the redaction
 * result: it would time out and fail closed, blocking every send on Firefox.
 * `cloneInto` is Gecko-only, hence the capability test rather than a UA check.
 */
const toPageDetail =
  typeof cloneInto === "function" ? (detail) => cloneInto(detail, window) : (detail) => detail;

// `tripwire`/`tripwireEndpoints` are omitted here so they fall back to the
// MAIN-world defaults (tripwire ON, built-in endpoint list) unless managed/local
// storage explicitly overrides them. Only keys present in storage are relayed.
//
// Every key content-main.js reads off CONFIG must be listed, or it is dead config:
// storage is read, the key is dropped here, and MAIN silently keeps its default.
// `uploadPolicy` was missing, which made the documented "warn" escape hatch
// unreachable in a real browser — the e2e sets config by dispatching the MAIN
// event directly, so it never exercised this list. `tests/phase-upload.test.ts`
// now guards it.
const DEFAULTS = { base: "http://127.0.0.1:8001", enabled: true };
const CONFIG_KEYS = [
  "base",
  "enabled",
  "tripwire",
  "tripwireEndpoints",
  "debug",
  "uploadGuard",
  "uploadPolicy",
];

// Startup race: MAIN world arrives as an async `<script type="module">` load
// (loader.js) while the config below arrives from an async storage read. If the
// storage read wins, the only config event is dispatched before content-main.js
// has registered its listener and MAIN keeps its defaults — which also means
// `applyTripwire()` never runs, silently leaving the fail-closed tripwire OFF.
// Observed on Firefox, but it is a race on every browser. Re-publishing a few
// times closes it; the MAIN-side handler merges config and arms the tripwire
// idempotently, so extra events are harmless.
const REPUBLISH_DELAYS_MS = [0, 100, 500, 1500];

/** Dispatch one MAIN-world event now. */
function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail: toPageDetail(detail) }));
}

/** Dispatch a state event repeatedly so a late MAIN world still receives it. */
function publish(name, detail) {
  for (const delay of REPUBLISH_DELAYS_MS) {
    if (delay === 0) emit(name, detail);
    else setTimeout(() => emit(name, detail), delay);
  }
}

// storage.managed carries enterprise-pushed config (Stage 6); local is the
// user/dev fallback. Managed wins when present. Safari has no `managed` area —
// storageGet resolves {} for a missing area, so it degrades to local.
function load() {
  const store = (api && api.storage) || null;
  if (!store) {
    publish("gemini-redact:config", DEFAULTS);
    return;
  }
  Promise.all([storageGet(store.managed, CONFIG_KEYS), storageGet(store.local, CONFIG_KEYS)]).then(
    ([managed, local]) => {
      // Later (local) overrides earlier (managed) ONLY for keys managed didn't set.
      const merged = Object.assign({}, DEFAULTS, local || {}, stripUndefined(managed || {}));
      publish("gemini-redact:config", merged);
    },
  );
}

function stripUndefined(o) {
  const out = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

// Relay redaction requests from MAIN world to the background (the only place a
// gateway fetch is allowed — see background.js). MAIN cannot call api.runtime;
// this isolated world can.
window.addEventListener("gemini-redact:redact-request", (e) => {
  const detail = (e && e.detail) || {};
  const { id, text } = detail;
  // One-shot and correlated by id, so unlike config this must not be republished.
  const respond = (result) => emit("gemini-redact:redact-response", { id, result: result || { ok: false } });
  // sendMessage resolves undefined when there is no receiver (dead worker) or
  // messaging is unavailable -> respond({ok:false}) -> caller fails closed.
  sendMessage({ type: "redact", text }).then(respond, () => respond({ ok: false }));
});

// Relay an admin surface-policy request MAIN -> background -> gateway
// (GET /internal/config/:surface) and hand the {enabled,mode} back. Correlated
// by surface; null result means the poll failed and MAIN keeps its last policy.
window.addEventListener("gemini-redact:policy-request", (e) => {
  const surface = (e && e.detail && e.detail.surface) || "";
  const respond = (result) => emit("gemini-redact:policy-response", { surface, result: result || null });
  sendMessage({ type: "getSurfaceConfig", surface }).then(respond, () => respond(null));
});

// Relay per-turn chat logging (redacted prompt + response) MAIN -> background.
// Fire-and-forget: MAIN doesn't await a response.
window.addEventListener("gemini-redact:log-turn", (e) => {
  const turn = (e && e.detail) || {};
  sendMessage({ type: "logTurn", turn }).catch(() => {
    /* no receiver — non-fatal */
  });
});

// LAYER 1.5 — persist/restore the learned composer fingerprint. MAIN world
// learns it (from a focused submit) but can't touch extension storage; this
// isolated world saves it and pushes the saved one back on load. A fingerprint
// is shape metadata only (tag/role/aria-label/class names) — never PII.
// Republished for the same startup-race reason as the config event: a learned
// fingerprint that MAIN misses costs the Layer-1.5 composer recall.
function pushLearned(fp) {
  publish("gemini-redact:learned-composer", { fingerprint: fp || null });
}
function loadLearned() {
  const local = (api && api.storage && api.storage.local) || null;
  if (!local) return;
  storageGet(local, ["learnedComposer"]).then((v) => pushLearned((v && v.learnedComposer) || null));
}
window.addEventListener("gemini-redact:learn-composer", (e) => {
  const fp = (e && e.detail && e.detail.fingerprint) || null;
  const local = (api && api.storage && api.storage.local) || null;
  if (!fp || !local) return;
  storageSet(local, { learnedComposer: fp });
});

// Surface fail-closed blocks to the extension (badge/toast) if wired later. This
// direction needs no cloning: the isolated world can read page objects.
window.addEventListener("gemini-redact:blocked", (e) => {
  sendMessage({ type: "blocked", detail: e.detail }).catch(() => {
    /* no receiver — non-fatal */
  });
});

load();
loadLearned();
if (api && api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener(load);
}
