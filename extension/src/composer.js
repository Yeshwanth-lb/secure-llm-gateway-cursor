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
//
// LAYER 1 (DOM-change resilience): findComposer tries the exact selectors first
// (fast-path, no regression on the known DOM) and, only if none resolve to a
// sane box, falls back to a heuristic that RANKS candidate editable elements by
// shape (size, prompt-like label, proximity to a send button). The pure ranking
// lives in composer-finder.js and is unit-tested headlessly; this file only maps
// live DOM elements to the descriptors it scores. So a Gemini/Workspace UI
// reshuffle degrades to "still found by shape" instead of "not found -> blocked".

import { pickComposer, MIN_COMPOSER_AREA } from "./composer-finder.js";
import { chooseComposer } from "./composer-learn.js";

// LAYER 1.5 — a composer fingerprint learned from a prior submit (see
// composer-learn.js). Set by content-main.js from chrome.storage on load;
// consulted by findComposer to recall the composer after a Google redesign.
let learnedFingerprint = null;
/** content-main.js calls this with the persisted fingerprint (or null). */
export function setLearnedComposer(fp) {
  learnedFingerprint = fp || null;
}
/** Emit a learned fingerprint so the isolated bridge can persist it. */
let lastPersisted = "";
function persistFingerprint(fp) {
  try {
    const key = JSON.stringify(fp);
    if (!fp || key === lastPersisted) return;
    lastPersisted = key;
    learnedFingerprint = fp;
    window.dispatchEvent(new CustomEvent("gemini-redact:learn-composer", { detail: { fingerprint: fp } }));
  } catch {
    /* non-fatal */
  }
}

// Candidate selectors for Gemini's composer, most-specific first. Centralized
// so the Stage 5 health check has one place to verify and so a UI change is a
// one-line fix. ADJUST against the live site during Stage 2.
// FAST-PATH selectors — Gemini/Workspace-SPECIFIC and high-confidence ONLY.
// Deliberately NO generic catch-alls (`div[role=textbox]`, `textarea[aria-label]`):
// a generic selector can match the WRONG sane element (a search box, a doc
// canvas, or the ambiguous-box case) and the blind fast-path would return it
// before the stronger focus/learned signals run — which leaked raw PII in the
// Layer-1.5 e2e. Generic editables are instead ranked by the fallback
// (focus > learned fingerprint > heuristic shape), where the box the user is
// actually typing in wins. The Sheets stray `role=textbox` decoy is handled
// there too (disqualified on area). ADJUST against the live site during Stage 2.
const COMPOSER_SELECTORS = [
  'div.ql-editor[contenteditable="true"]', // gemini.google.com — Quill editor
  "rich-textarea .ql-editor",
  // Workspace apps (Gmail/Docs/Sheets/Slides/Drive/Chat) — appsElements composer.
  'div[contenteditable="true"][aria-label*="Ask Gemini" i]',
];

/**
 * Is this element a plausibly-real composer box (visible + large enough)? Used
 * to reject the fast-path from returning a decoy — notably Sheets' stray empty
 * `role="textbox"` (area ~0) that matched a generic selector and caused an
 * unredacted send (live bug 2026-07-21).
 */
function isSaneComposer(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return false;
  if (el.offsetParent === null && el.getClientRects().length === 0) return false; // hidden
  const r = el.getBoundingClientRect();
  return r.width * r.height >= MIN_COMPOSER_AREA;
}

/**
 * Map a live element to the plain descriptor scored by composer-finder.js.
 * Browser-only (reads layout + attributes); the scoring it feeds is pure.
 */
export function describeCandidate(el, root = document) {
  const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  const visible = el.offsetParent !== null || (typeof el.getClientRects === "function" && el.getClientRects().length > 0);
  const vw = (root.defaultView && root.defaultView.innerWidth) || window.innerWidth || 0;
  const vh = (root.defaultView && root.defaultView.innerHeight) || window.innerHeight || 0;
  const offscreen = vw > 0 && vh > 0 ? r.bottom <= 0 || r.right <= 0 || r.left >= vw || r.top >= vh : false;
  const tag = (el.tagName || "").toLowerCase();
  const isTextarea = tag === "textarea";
  return {
    editable: isTextarea || el.getAttribute("contenteditable") === "true" || el.getAttribute("role") === "textbox",
    visible,
    offscreen,
    area: r.width * r.height,
    ariaLabel: el.getAttribute("aria-label") || "",
    placeholder: el.getAttribute("placeholder") || "",
    role: el.getAttribute("role") || "",
    tag,
    nearSend: hasNearbySend(r, root),
    textLen: (isTextarea ? el.value : el.textContent || "").length,
    classList: el.classList ? Array.from(el.classList) : [],
  };
}

/** True if a visible, enabled send button sits within ~1.5 composer-heights. */
function hasNearbySend(rect, root) {
  const btn = findSendButton(root);
  if (!btn || btn.disabled) return false;
  if (typeof btn.getBoundingClientRect !== "function") return true; // can't measure -> assume near
  const b = btn.getBoundingClientRect();
  const dx = Math.max(0, Math.max(rect.left - b.right, b.left - rect.right));
  const dy = Math.max(0, Math.max(rect.top - b.bottom, b.top - rect.bottom));
  const near = Math.max(rect.height, 40) * 1.5;
  return dx <= near && dy <= near;
}

/**
 * Find the prompt composer element, or null if nothing plausible resolves.
 * Fast-path: the exact selectors (returns the first that yields a SANE box).
 * Fallback: rank all editable candidates heuristically (survives DOM changes).
 */
export function findComposer(root = document) {
  // Fast-path — exact selectors, but only accept a sane (visible, sized) hit so
  // a decoy match can't win over the real composer.
  for (const sel of COMPOSER_SELECTORS) {
    let el;
    try {
      el = root.querySelector(sel);
    } catch {
      continue; // a selector the engine can't parse (e.g. :has) — skip it
    }
    if (el && isSaneComposer(el)) return el;
  }
  // Self-heal fallback. Gather every editable candidate, then choose using the
  // strongest signal: the FOCUSED box (Layer 1.5) > a learned fingerprint >
  // heuristic shape (Layer 1). Focus/learned beat pure shape when several big
  // editable boxes compete (a search box, a doc canvas — "Case B").
  let candidates;
  try {
    candidates = Array.from(root.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]'));
  } catch {
    candidates = [];
  }
  if (candidates.length === 0) return null;
  const descriptors = candidates.map((el) => describeCandidate(el, root));
  const active = activeEditable(root);
  const activeIndex = active ? candidates.indexOf(active) : -1;
  const decision = chooseComposer({ activeIndex, descriptors, learnedFingerprint });
  if (decision.index < 0) return null;
  // Learn this composer (from the focus signal) so a later load recalls it.
  if (decision.fingerprintToPersist) persistFingerprint(decision.fingerprintToPersist);
  return candidates[decision.index];
}

/**
 * The candidate the user is currently typing in: document.activeElement if it is
 * one of our editable candidates, else its nearest editable ancestor. Used as
 * the Layer-1.5 focus signal. Returns null if focus isn't on an editable.
 */
function activeEditable(root) {
  const doc = root.ownerDocument || (root.defaultView ? root : document);
  const a = (doc.activeElement || document.activeElement) ?? null;
  if (!a) return null;
  const isEditable = (el) =>
    el &&
    ((el.tagName || "").toLowerCase() === "textarea" ||
      el.getAttribute?.("contenteditable") === "true" ||
      el.getAttribute?.("role") === "textbox");
  let el = a;
  while (el && el !== doc.body) {
    if (isEditable(el)) return el;
    el = el.parentElement;
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
// `resolveResponseEls` returns the FIRST selector that has any matches, so
// gemini.google.com selectors stay first; the Google Workspace side-panel
// (appsElements) selectors follow. The Workspace assistant reply lives in
// `.appsElementsSidekickAgentMessageBubbleContent` ("Agent" = Gemini, not the
// user's own bubble) — verified live 2026-07-21 in Docs; shared across the
// Workspace side-panel apps. Without these, Workspace turns log an empty
// response ("(none)") because the gemini.google.com selectors don't match.
const RESPONSE_SELECTORS = [
  // gemini.google.com
  "message-content .markdown",
  ".model-response-text .markdown",
  ".model-response-text",
  "message-content",
  ".response-container .markdown",
  // Google Workspace side panel (Gmail/Docs/Sheets/Slides — appsElements).
  // Exact class first, then a substring match to catch per-app class variants.
  ".appsElementsSidekickAgentMessageBubbleContent",
  "[class*='SidekickAgentMessageBubbleContent']",
  "[class*='SidekickAgentMessage']",
  ".appsElementsSidekickAgentMessageRoot",
];

/**
 * Resolve the assistant-response node list via the explicit RESPONSE_SELECTORS.
 * These are STABLE, semantic selectors: gemini.google.com's response markup and
 * Docs/Sheets/Slides' `appsElements` agent-message classes. Returns the first
 * selector that hits, else [].
 *
 * NOTE — deliberately NO generic/role-based fallback. Apps like Gmail render the
 * Gemini feed with OBFUSCATED, per-build-rotating class names AND interleave
 * suggestion chips ("Show me my unread emails", "Show fewer suggestions") as
 * sibling `[role="listitem"]`s that come AFTER the reply. A "last listitem"
 * heuristic reliably grabs a suggestion chip, not the reply — logging the wrong
 * text as the assistant output, which is worse than showing "(none)" in an audit
 * view (a wrong pairing misleads; a blank one doesn't). So on obfuscated surfaces
 * we log the prompt (the security-critical part, redacted) and leave the response
 * empty rather than guess. Response capture is cosmetic; prompt redaction — the
 * actual control — works on every surface regardless.
 */
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

/** Best-effort read of the LATEST assistant response text, or "" if none found.
 *  Returns the last NON-EMPTY matching node: Gemini/Workspace often append a
 *  trailing EMPTY node (a next-turn placeholder, a chip/feedback container) after
 *  the reply, and reading the bare last node would intermittently return "" while
 *  the reply is sitting right above it. Walk from the end to the first node that
 *  actually has text. */
export function readLatestResponse(root = document) {
  const els = resolveResponseEls(root);
  for (let i = els.length - 1; i >= 0; i--) {
    const t = (els[i].innerText || els[i].textContent || "").trim();
    if (t) return t;
  }
  return "";
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
