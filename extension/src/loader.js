// ===== LOADER (ISOLATED world) — inject the MAIN-world ES module ===========
// MV3 content scripts cannot use ESM `import` directly, but we author the core
// as ES modules so it stays unit-testable (node --test). Bridge that gap
// without a bundler: this isolated-world content script injects a
// `<script type="module">` into the page that imports content-main.js from the
// extension's web-accessible URL, so its relative imports resolve normally and
// it runs in the page's MAIN world (needed to see Gemini's own composer/events).
//
// Design ref: scripts/gemini_imp.md §4.1 (MAIN world, document_start).

(function injectMain() {
  try {
    const url = chrome.runtime.getURL("src/content-main.js");
    const s = document.createElement("script");
    s.type = "module";
    s.src = url;
    s.dataset.geminiRedact = "1";
    // document_start: <head> may not exist yet — documentElement always does.
    (document.head || document.documentElement).appendChild(s);
    // The module keeps running after the tag is removed; drop it to stay tidy.
    s.addEventListener("load", () => s.remove());
  } catch (e) {
    // If injection fails we CANNOT redact — surface it so the UI can fail closed.
    console.error("[gemini-redact] loader failed to inject MAIN module:", e);
    window.dispatchEvent(new CustomEvent("gemini-redact:blocked", { detail: { reason: "loader-failed" } }));
  }
})();
