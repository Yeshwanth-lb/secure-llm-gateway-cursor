// ===== BACKGROUND SERVICE WORKER — the ONLY component that may fetch the gateway
// Cross-origin fetch to the loopback gateway CANNOT be done from the page (MAIN
// world) or a content script: the gateway grants CORS to LOOPBACK origins only
// (src/server.ts corsHeaders, §5), and gemini.google.com is not loopback, so a
// page-context fetch is blocked by the browser. The extension service worker,
// however, has `host_permissions` for http://127.0.0.1:8001/* and its fetch is
// extension-privileged (not subject to page CORS). So ALL gateway calls funnel
// here, reached from the page via: MAIN -> CustomEvent -> bridge ->
// api.runtime.sendMessage -> here.
//
// Runs as an MV3 service worker on Chrome and as a non-persistent event page on
// Firefox/Safari (neither supports `background.service_worker` — the manifests
// declare both keys). Nothing here depends on which one it is: the listener is
// registered at the top level, and config is re-read from storage rather than
// held across an unload.
//
// Design ref: scripts/gemini_imp.md §4 (revised — fetch moved off the page).

import "./browser-api.js";
import { redact, logTurn } from "./redact-client.js";

const { api, storageGet } = globalThis.geminiRedactBrowserApi;

let CONFIG = { base: "http://127.0.0.1:8001" };

function loadConfig() {
  const store = (api && api.storage) || null;
  if (!store) return;
  Promise.all([storageGet(store.managed, ["base"]), storageGet(store.local, ["base"])]).then(
    ([managed, local]) => {
      const base = (managed && managed.base) || (local && local.base) || CONFIG.base;
      CONFIG = { base };
    },
  );
}
loadConfig();
if (api && api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener(loadConfig);
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "redact" && typeof msg.text === "string") {
    // redact() never throws; resolves {ok:false} on any failure (fail-closed).
    redact(msg.text, { base: CONFIG.base }).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (msg && msg.type === "logTurn" && msg.turn) {
    // Fire-and-forget per-turn logging (redacted prompt + response).
    logTurn(msg.turn, { base: CONFIG.base }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
