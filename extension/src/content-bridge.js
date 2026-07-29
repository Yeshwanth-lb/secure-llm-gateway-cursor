// ===== CONTENT SCRIPT (ISOLATED world) — config bridge =====================
// The MAIN-world script (content-main.js) can see the page but NOT extension
// APIs (chrome.storage). This isolated-world script has the opposite access, so
// it relays configuration (gateway URL, enabled toggle) into MAIN world via a
// DOM CustomEvent. No PII and no token map ever cross this bridge — there is no
// map in this design (rev.2), and prompt text never leaves the MAIN world.
//
// Design ref: scripts/gemini_imp.md §4.2.

// `tripwire`/`tripwireEndpoints` are omitted here so they fall back to the
// MAIN-world defaults (tripwire ON, built-in endpoint list) unless managed/local
// storage explicitly overrides them. Only keys present in storage are relayed.
const DEFAULTS = { base: "http://127.0.0.1:8001", enabled: true };
const CONFIG_KEYS = ["base", "enabled", "tripwire", "tripwireEndpoints", "debug"];

function push(cfg) {
  window.dispatchEvent(new CustomEvent("gemini-redact:config", { detail: cfg }));
}

// chrome.storage.managed carries enterprise-pushed config (Stage 6); local is
// the user/dev fallback. Managed wins when present.
function load() {
  const store = (globalThis.chrome && chrome.storage) || null;
  if (!store) {
    push(DEFAULTS);
    return;
  }
  const areas = [store.managed, store.local].filter(Boolean);
  Promise.all(
    areas.map((a) => new Promise((res) => a.get(CONFIG_KEYS, (v) => res(v || {})))),
  ).then((results) => {
    // Later (local) overrides earlier (managed) ONLY for keys managed didn't set.
    const merged = Object.assign({}, DEFAULTS, results[1] || {}, stripUndefined(results[0] || {}));
    push(merged);
  });
}

function stripUndefined(o) {
  const out = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

// Relay redaction requests from MAIN world to the background service worker
// (the only place a gateway fetch is allowed — see background.js). MAIN cannot
// call chrome.runtime; this isolated world can.
window.addEventListener("gemini-redact:redact-request", (e) => {
  const detail = (e && e.detail) || {};
  const { id, text } = detail;
  const respond = (result) =>
    window.dispatchEvent(
      new CustomEvent("gemini-redact:redact-response", { detail: { id, result: result || { ok: false } } }),
    );
  if (!(globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage)) {
    respond({ ok: false }); // no extension messaging -> fail closed
    return;
  }
  try {
    chrome.runtime.sendMessage({ type: "redact", text }, (result) => {
      // chrome.runtime.lastError (dead worker) -> undefined result -> fail closed.
      respond(result);
    });
  } catch {
    respond({ ok: false });
  }
});

// Relay per-turn chat logging (redacted prompt + response) MAIN -> background.
// Fire-and-forget: MAIN doesn't await a response.
window.addEventListener("gemini-redact:log-turn", (e) => {
  const turn = (e && e.detail) || {};
  if (!(globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage)) return;
  try {
    chrome.runtime.sendMessage({ type: "logTurn", turn }, () => void chrome.runtime.lastError);
  } catch {
    /* no receiver — non-fatal */
  }
});

// LAYER 1.5 — persist/restore the learned composer fingerprint. MAIN world
// learns it (from a focused submit) but can't touch chrome.storage; this
// isolated world saves it and pushes the saved one back on load. A fingerprint
// is shape metadata only (tag/role/aria-label/class names) — never PII.
function pushLearned(fp) {
  window.dispatchEvent(new CustomEvent("gemini-redact:learned-composer", { detail: { fingerprint: fp || null } }));
}
function loadLearned() {
  const store = (globalThis.chrome && chrome.storage && chrome.storage.local) || null;
  if (!store) return;
  try {
    store.get(["learnedComposer"], (v) => pushLearned((v && v.learnedComposer) || null));
  } catch {
    /* non-fatal */
  }
}
window.addEventListener("gemini-redact:learn-composer", (e) => {
  const fp = (e && e.detail && e.detail.fingerprint) || null;
  const store = (globalThis.chrome && chrome.storage && chrome.storage.local) || null;
  if (!fp || !store) return;
  try {
    store.set({ learnedComposer: fp });
  } catch {
    /* non-fatal */
  }
});

// Surface fail-closed blocks to the extension (badge/toast) if wired later.
window.addEventListener("gemini-redact:blocked", (e) => {
  if (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      chrome.runtime.sendMessage({ type: "blocked", detail: e.detail });
    } catch {
      /* no receiver — non-fatal */
    }
  }
});

load();
loadLearned();
if (globalThis.chrome && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(load);
}
