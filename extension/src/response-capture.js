// ===== RESPONSE CAPTURE (DOM) — class-name-free assistant-reply capture ======
// Browser-only glue for response-finder.js (pure ranking). Used by
// content-main.js AFTER the semantic RESPONSE_SELECTORS miss — i.e. on the
// obfuscated Gemini panels (Gmail, Drive, Chat) where class names rotate every
// Google deploy and there is nothing stable to select. Those surfaces logged
// "(none)" as the assistant output; this recovers it without inventing selectors.
//
// The anchor is the one thing we always know: the exact text we just submitted.
// Find the tightest element containing it (the user's own message bubble), and
// the reply must be a non-interactive block AFTER it that appeared with this
// turn and/or grew while the model streamed. Bounding the search to the anchor's
// nearest text-bearing ancestor keeps this cheap on huge DOMs like Gmail.
//
// Security note: this only READS rendered text for the audit log. The prompt is
// already redacted on the wire by the time a reply exists, and /log-turn redacts
// again server-side before storing. Nothing here can affect whether a send is
// blocked.
//
// Design ref: WORKSPACE_COVERAGE.md §5.6 (the three panel DOMs).

import { pickResponse, MIN_RESPONSE_LEN } from "./response-finder.js";

/** Don't re-walk the DOM more often than this (streaming fires many mutations). */
const SAMPLE_INTERVAL_MS = 250;
/** How far up from the anchor we look for a container that holds the reply too.
 *  Kept TIGHT on purpose: widening it (tried in 9314f14) made the shape finder on
 *  Chat's obfuscated DOM climb into the message-LIST container and log sender
 *  labels + timestamps ("Ask Gemini , 1 min ,") as the reply — a wrong pairing,
 *  which is worse than a blank one. Reverted. */
const MAX_SCOPE_HOPS = 8;
/** Safety valve: never score more candidates than this in one pass. */
const MAX_CANDIDATES = 600;
/** Cap what we hand to the gateway (it stores a snapshot, not a transcript). */
const MAX_RESPONSE_CHARS = 20000;
/** A child holding this share of its parent's text makes the parent redundant. */
const TIGHT_WRAPPER_RATIO = 0.9;
/** Node.DOCUMENT_POSITION_FOLLOWING, inlined so this module is testable off-DOM. */
const DOCUMENT_POSITION_FOLLOWING = 4;

// Controls a reply can never be, plus the composer itself (`contenteditable`):
// on some surfaces the submitted text lingers in the box after a send, and the
// prompt must never be logged back as the model's answer.
const INTERACTIVE_SELECTOR =
  'button, a[href], [role="button"], [role="link"], [role="option"], [role="menuitem"], [role="tab"], [role="checkbox"], input, textarea, select, [contenteditable="true"]';

const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

// textContent, not innerText: innerText forces a reflow per element, and we
// touch thousands of them per pass on a DOM the size of Gmail's.
const textOf = (el) => norm(el.textContent);

function isVisible(el) {
  if (el.offsetParent !== null) return true;
  return typeof el.getClientRects === "function" && el.getClientRects().length > 0;
}

/**
 * Fast path for the anchor: scan TEXT NODES for the prompt and return the last
 * match's element. Concatenating `textContent` for every element on a DOM the
 * size of Gmail's is quadratic-ish and would jank the page while a reply
 * streams; this pass touches each character once. Misses (and falls through to
 * the element scan) when the bubble splits the prompt across several nodes.
 */
function anchorViaTextNodes(root, body, target, skip) {
  if (!root || typeof root.createTreeWalker !== "function") return null;
  const filter = (root.defaultView && root.defaultView.NodeFilter) || globalThis.NodeFilter;
  if (!filter) return null;
  let found = null;
  try {
    const walker = root.createTreeWalker(body, filter.SHOW_TEXT);
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!el || !norm(walker.currentNode.nodeValue).includes(target)) continue;
      if (skip && (el === skip || skip.contains(el) || el.contains(skip))) continue;
      found = el; // keep going: the LAST match is the newest turn
    }
  } catch {
    return null;
  }
  return found;
}

/** How many levels below `stop` an element sits. */
function depthOf(el, stop) {
  let d = 0;
  let p = el.parentElement;
  while (p && p !== stop) {
    d++;
    p = p.parentElement;
  }
  return d;
}

/**
 * The DEEPEST element whose text contains `needle` — the user's own message
 * bubble. Depth, not text length, is what distinguishes it: on a first turn the
 * whole conversation container holds exactly the prompt too, and anchoring
 * there would swallow the reply (it would be a descendant of the anchor, and
 * descendants are excluded). At equal depth the LAST match wins, so re-sending
 * the same prompt anchors on the newest turn.
 *
 * `skip` (the composer, which may still hold the submitted text) and anything
 * containing it are ignored.
 */
function findPromptAnchor(root, needle, skip) {
  const target = norm(needle);
  if (target.length < MIN_RESPONSE_LEN) return null;
  const body = root.body || root;
  if (!body || typeof body.querySelectorAll !== "function") return null;
  const fast = anchorViaTextNodes(root, body, target, skip);
  if (fast) return fast;
  let best = null;
  let bestDepth = -1;
  for (const el of body.querySelectorAll("*")) {
    if (skip && (el === skip || skip.contains(el) || el.contains(skip))) continue;
    if (!textOf(el).includes(target)) continue;
    const d = depthOf(el, body);
    if (d >= bestDepth) {
      best = el;
      bestDepth = d;
    }
  }
  return best;
}

/**
 * Smallest ancestor of `anchor` that also holds other content — the reply lands
 * in here, so it bounds the candidate walk. Kept tight (see MAX_SCOPE_HOPS): a
 * wider scope on the obfuscated panels pulls in the whole message list, and the
 * shape finder then logs sender/timestamp metadata as the reply.
 */
function findScope(anchor) {
  const anchorLen = textOf(anchor).length;
  let el = anchor.parentElement;
  let last = null;
  for (let i = 0; i < MAX_SCOPE_HOPS && el; i++) {
    last = el;
    if (textOf(el).length >= anchorLen + MIN_RESPONSE_LEN) return el;
    el = el.parentElement;
  }
  return last;
}

/** Share of an element's text that sits inside interactive descendants. */
function interactiveTextRatio(el, totalLen) {
  if (totalLen <= 0) return 0;
  let counted = 0;
  const claimed = [];
  for (const node of el.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (claimed.some((c) => c.contains(node))) continue; // don't double-count nesting
    claimed.push(node);
    counted += textOf(node).length;
  }
  return Math.min(1, counted / totalLen);
}

/** Readable text for the audit row: keep paragraph breaks, drop the noise. */
function displayText(el) {
  const raw = typeof el.innerText === "string" && el.innerText ? el.innerText : el.textContent || "";
  return raw.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_RESPONSE_CHARS);
}

/**
 * Create a capture for one turn. `sentText` is the (already redacted) text we
 * submitted — the anchor. Call `sample()` from a MutationObserver and `read()`
 * once the reply has settled; `read()` returns "" when nothing is trustworthy.
 */
export function createResponseCapture(sentText, root = document, composerEl = null) {
  // element -> { maxLen, steps, firstTick }
  const seen = new Map();
  let anchor = null;
  let baselineTick = -1; // the tick at which the anchor first existed
  let tick = -1;
  let lastSampleAt = 0;
  let picked = null; // the winning element from the most recent sample

  function candidatesNow() {
    if (!anchor || !anchor.isConnected) return [];
    const scope = findScope(anchor);
    if (!scope || typeof scope.querySelectorAll !== "function") return [];
    const target = norm(sentText);
    const out = [];
    for (const el of scope.querySelectorAll("*")) {
      if (out.length >= MAX_CANDIDATES) break;
      if (el === anchor || anchor.contains(el) || el.contains(anchor)) continue;
      // Strictly after the user's message: anything before it belongs to an
      // earlier turn, and pairing that with this prompt would be a lie.
      if (!(anchor.compareDocumentPosition(el) & DOCUMENT_POSITION_FOLLOWING)) continue;
      const text = textOf(el);
      if (text.length < MIN_RESPONSE_LEN) continue;
      // Keep only the tightest wrapper of a block of text, so a chain of
      // near-identical ancestors isn't scored over and over.
      let redundant = false;
      for (const child of el.children) {
        if (textOf(child).length >= text.length * TIGHT_WRAPPER_RATIO) {
          redundant = true;
          break;
        }
      }
      if (redundant) continue;
      out.push({ el, text, containsPrompt: !!target && text.includes(target) });
    }
    return out;
  }

  function describe(entry) {
    const rec = seen.get(entry.el);
    return {
      textLen: entry.text.length,
      grew: !!rec && rec.steps > 0,
      growthSteps: rec ? rec.steps : 0,
      followsPrompt: true, // enforced by candidatesNow
      containsPrompt: entry.containsPrompt,
      interactive: !!entry.el.closest(INTERACTIVE_SELECTOR),
      interactiveTextRatio: interactiveTextRatio(entry.el, entry.text.length),
      appearedAfterSubmit: !!rec && baselineTick >= 0 && rec.firstTick > baselineTick,
      visible: isVisible(entry.el),
    };
  }

  /**
   * Walk the DOM, update growth bookkeeping, and re-pick the best candidate.
   * Throttled — streaming fires a mutation per token.
   */
  function sample(force = false) {
    const now = Date.now();
    if (!force && now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
    lastSampleAt = now;
    tick++;
    if (!anchor || !anchor.isConnected) {
      anchor = findPromptAnchor(root, sentText, composerEl);
      if (!anchor) return;
      baselineTick = tick;
    }
    const entries = candidatesNow();
    for (const entry of entries) {
      const rec = seen.get(entry.el);
      if (!rec) {
        seen.set(entry.el, { maxLen: entry.text.length, steps: 0, firstTick: tick });
      } else if (entry.text.length > rec.maxLen) {
        rec.maxLen = entry.text.length;
        rec.steps++;
      }
    }
    const idx = pickResponse(entries.map(describe));
    picked = idx < 0 ? null : entries[idx].el;
  }

  /** True once some candidate would be accepted — lets the caller stop waiting. */
  function hasCandidate() {
    return picked !== null;
  }

  /** The captured reply text, or "" if nothing is trustworthy enough to log. */
  function read() {
    sample(true);
    return picked ? displayText(picked) : "";
  }

  return { sample, hasCandidate, read };
}
