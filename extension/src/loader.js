// ===== LOADER (ISOLATED world) — inject the MAIN-world ES module ===========
// MV3 content scripts cannot use ESM `import` directly, but we author the core
// as ES modules so it stays unit-testable (node --test). Bridge that gap
// without a bundler: this isolated-world content script injects a
// `<script type="module">` into the page that imports content-main.js from the
// extension's web-accessible URL, so its relative imports resolve normally and
// it runs in the page's MAIN world (needed to see Gemini's own composer/events).
//
// A native `world: "MAIN"` content script (Chrome, Firefox 128+) is NOT usable
// here: content scripts are loaded as classic scripts, and content-main.js is an
// ES module with relative imports. So this injection path is the only one, on
// every browser.
//
// Cross-browser risk this guards: Firefox applies the PAGE's CSP to a tag a
// content script inserts (Gecko bugs 1267027 / 1591983), whereas Chrome exempts
// extension-origin scripts. If a Gemini page's `script-src` refuses the
// extension URL, the MAIN module never runs — and with it neither the submit
// interceptor nor the tripwire, so a send would go out RAW. That would be a
// silent leak, the one outcome the design forbids, so a failed load is escalated
// as a `blocked` event exactly like a missing composer.
//
// Design ref: scripts/gemini_imp.md §4.1 (MAIN world, document_start).

(function injectMain() {
  const { api } = globalThis.geminiRedactBrowserApi;
  const fail = (reason, detail) => {
    console.error("[gemini-redact] loader could not inject the MAIN module:", reason, detail || "");
    window.dispatchEvent(new CustomEvent("gemini-redact:blocked", { detail: { reason: "loader-failed", cause: reason } }));
  };
  try {
    const url = api.runtime.getURL("src/content-main.js");
    const s = document.createElement("script");
    s.type = "module";
    s.src = url;
    s.dataset.geminiRedact = "1";
    // A CSP refusal or a missing resource surfaces as an `error` event on the
    // element rather than a throw, so it needs its own listener.
    s.addEventListener("error", (e) => fail("script-load-blocked", e && e.type));
    // document_start: <head> may not exist yet — documentElement always does.
    (document.head || document.documentElement).appendChild(s);
    // The module keeps running after the tag is removed; drop it to stay tidy.
    s.addEventListener("load", () => s.remove());
  } catch (e) {
    // If injection fails we CANNOT redact — surface it so the UI can fail closed.
    fail("inject-threw", e);
  }
})();
