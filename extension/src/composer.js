// ===== COMPOSER — DOM read/write for the Gemini prompt box =================
// All the genuinely browser-dependent, selector-fragile logic lives here. This
// is the code most likely to break on a Gemini UI change (see §7 risk 3/5),
// and is validated against the LIVE page in Stage 2/3, not headlessly.
//
// Design ref: scripts/gemini_imp.md §4.1. Two hard requirements it encodes:
//   1. Writing text must update the framework's MODEL, not just the DOM node
//      (§7 risk 3) — so we use the native value setter + a real `input` event.
//   2. Selectors are centralized here and health-checked (Stage 5) so a break
//      is detectable and can fail closed rather than leak silently.

// Candidate selectors for Gemini's composer, most-specific first. Centralized
// so the Stage 5 health check has one place to verify and so a UI change is a
// one-line fix. ADJUST against the live site during Stage 2.
const COMPOSER_SELECTORS = [
  'div.ql-editor[contenteditable="true"]', // Gemini uses a Quill-based editor
  'rich-textarea .ql-editor',
  // Workspace apps (Gmail/Docs/Sheets/Slides/Drive/Chat) — appsElements composer,
  // not Quill. MUST precede the generic role=textbox / textarea selectors below:
  // Sheets renders empty stray `role="textbox"` contenteditables that the generic
  // selector would match FIRST, making readText return "" → the send is treated
  // as empty and goes out UNREDACTED (live bug found 2026-07-21). Matching the
  // aria-labelled composer first reads the real text.
  'div[contenteditable="true"][aria-label*="Ask Gemini" i]',
  'div[contenteditable="true"][role="textbox"]',
  'textarea[aria-label]',
];

/** Find the prompt composer element, or null if none of the selectors resolve. */
export function findComposer(root = document) {
  for (const sel of COMPOSER_SELECTORS) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** Read the current prompt text from the composer. */
export function readText(el) {
  if (!el) return "";
  if ("value" in el && typeof el.value === "string") return el.value; // textarea
  return el.textContent || ""; // contenteditable
}

/**
 * Write `text` into the composer such that the page's framework notices.
 * Directly assigning textContent/value does NOT trigger framework change
 * detection (Angular/Quill keep their own model), which would let a STALE,
 * pre-redaction value get submitted (§7 risk 3). So we set via the native
 * prototype setter where applicable and dispatch a real `input` event.
 */
export function writeText(el, text) {
  if (!el) return false;
  if ("value" in el && typeof el.value === "string") {
    // <textarea>: use the native setter so React/Angular value tracking fires.
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return true;
  }
  // contenteditable (Quill/Angular): a bare `textContent = text` assignment does
  // NOT update the editor's own internal model, so the framework re-submits the
  // STALE (raw) text — the exact failure that leaked a real email in live
  // testing (§7 risk 3). Drive the replacement through the native input pipeline
  // the editor listens to: focus, select all, then execCommand insertText.
  // execCommand is deprecated but remains the most reliable cross-framework way
  // to edit a contenteditable such that Quill/Angular observe the change.
  try {
    el.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
    const ok = document.execCommand("insertText", false, text);
    if (ok) return true;
  } catch {
    /* fall through to the best-effort path */
  }
  // Fallback: textContent + input event (better than nothing if execCommand fails).
  el.textContent = text;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  return true;
}

/**
 * Locate the send button (best-effort; used as the programmatic re-submit path).
 * Gemini renders it only once the composer has text, and its label/markup vary
 * (localized aria-label, mat-icon-button, `send-button` class). Try several
 * shapes, most-specific first. ADJUST against the live site if re-submit fails.
 */
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

// Candidate selectors for the model-name label in Gemini's header (e.g.
// "Flash", "Pro"). Tunable against the live site.
const MODEL_SELECTORS = [
  '[data-test-id="bard-mode-menu-button"]',
  "bard-mode-switcher button",
  '[aria-label*="model" i] .logo-pill-label-container',
  ".logo-pill-label-container",
];

/** Best-effort read of the active Gemini model name → e.g. "gemini-flash". */
export function getModel(root = document) {
  for (const sel of MODEL_SELECTORS) {
    const el = root.querySelector(sel);
    const txt = el && (el.innerText || el.textContent || "").trim();
    if (txt) {
      const m = txt.match(/\b(flash|pro|ultra|nano|advanced|thinking)\b/i);
      if (m) return "gemini-" + m[1].toLowerCase();
    }
  }
  // Fallback: scan the header for a known tier word.
  const hdr = (root.body && root.body.innerText) || "";
  const m = hdr.slice(0, 400).match(/\b(flash|pro|ultra|nano)\b/i);
  return m ? "gemini-" + m[1].toLowerCase() : "gemini";
}

// Candidate selectors for the assistant's rendered response text. Tunable.
const RESPONSE_SELECTORS = [
  "message-content .markdown",
  ".model-response-text .markdown",
  ".model-response-text",
  "message-content",
  ".response-container .markdown",
];

/** Resolve the assistant-response node list via the first selector that hits. */
function resolveResponseEls(root) {
  for (const sel of RESPONSE_SELECTORS) {
    const els = root.querySelectorAll(sel);
    if (els.length) return els;
  }
  return [];
}

/** How many assistant-response nodes currently exist (for new-turn detection). */
export function responseCount(root = document) {
  return resolveResponseEls(root).length;
}

/** Best-effort read of the LATEST assistant response text, or "" if none found. */
export function readLatestResponse(root = document) {
  const els = resolveResponseEls(root);
  if (!els.length) return "";
  const last = els[els.length - 1];
  return (last.innerText || last.textContent || "").trim();
}

/**
 * Health check for Stage 5: do the selectors we depend on still resolve?
 * Returns { healthy, composer, sendButton }. When unhealthy the caller must
 * FAIL CLOSED (disable sending) rather than run with broken interception.
 */
export function selectorsHealthy(root = document) {
  const composer = !!findComposer(root);
  const sendButton = !!findSendButton(root);
  return { healthy: composer, composer, sendButton };
}
