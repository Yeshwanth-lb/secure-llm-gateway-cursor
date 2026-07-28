// ===== COMPOSER FINDER (PURE) — heuristic self-healing ranking =============
// LAYER 1 of the extension's DOM-change resilience. This module contains NO DOM
// access: it scores plain *descriptor* objects and ranks them. That keeps the
// ranking logic — the part that must survive a Gemini/Workspace UI change —
// unit-testable headlessly, in the same spirit as interceptor-core.js and
// tripwire.js.
//
// composer.js (browser-only) maps live elements to these descriptors via
// `describeCandidate()` and calls `pickComposer()`. It first tries the exact
// selector fast-path (no regression on today's known DOM); only when that finds
// nothing sane does it fall back to this heuristic. So a Google DOM reshuffle
// degrades to "still found by shape" instead of "not found -> every send
// blocked".
//
// Design ref: plan "Layer 1"; scripts/gemini_imp.md §7 risk 3/5.

/**
 * Minimum rendered area (px²) for an editable box to be considered a real
 * composer. Kills the Sheets stray empty `role="textbox"` decoy (area ~0) that
 * previously hijacked findComposer and caused an unredacted send (live bug
 * 2026-07-21). Tunable — a real prompt box is far larger than this floor.
 */
export const MIN_COMPOSER_AREA = 600;

// A composer's accessible name / nearby label usually reads like an invitation
// to type a prompt. Matching any of these is strong positive signal.
const PROMPT_LABEL_RE = /ask gemini|ask|message|prompt|reply|talk to gemini|type/i;
// Search / filter boxes are editable but are NOT the composer — negative signal.
const SEARCH_LABEL_RE = /search|find|filter/i;

/**
 * Score a single candidate descriptor. Higher = more composer-like.
 * Returns -Infinity for anything that cannot possibly be the composer, so the
 * caller can treat "best score is -Infinity" as "found nothing".
 *
 * descriptor = {
 *   editable: boolean,     // contenteditable / <textarea> / role=textbox
 *   visible: boolean,      // has layout (offsetParent / client rects)
 *   offscreen: boolean,    // rendered outside the viewport
 *   area: number,          // width*height in px²
 *   ariaLabel: string,     // aria-label (or nearest accessible name)
 *   placeholder: string,   // placeholder text if any
 *   role: string,          // aria role
 *   tag: string,           // lowercased tagName
 *   nearSend: boolean,     // an enabled+visible send button sits nearby
 *   textLen: number,       // current text length (tie-breaker only)
 * }
 */
export function scoreComposerCandidate(d) {
  if (!d || typeof d !== "object") return -Infinity;
  // Hard disqualifiers — a box failing any of these is never the composer.
  if (!d.editable) return -Infinity;
  if (!d.visible) return -Infinity;
  if (d.offscreen) return -Infinity;
  if (typeof d.area !== "number" || d.area < MIN_COMPOSER_AREA) return -Infinity;

  let score = 10; // base for a visible, editable, adequately-sized box

  const label = `${d.ariaLabel || ""} ${d.placeholder || ""}`;
  if (PROMPT_LABEL_RE.test(label)) score += 40; // strong: reads like a prompt box
  if (SEARCH_LABEL_RE.test(label)) score -= 30; // likely a search/filter field

  // Bigger editable box wins ties — log-scaled + capped so a giant page region
  // can't dominate purely on size.
  score += Math.min(20, Math.log2(d.area / MIN_COMPOSER_AREA) * 4);

  if (d.nearSend) score += 15; // a send button nearby is a good composer tell

  // Element-shape preference: dedicated editors over a generic div.
  if (d.tag === "textarea") score += 6;
  else if (d.role === "textbox" || d.tag === "div") score += 3;

  return score;
}

/**
 * Rank descriptors and return the index of the best composer candidate, or -1
 * if none is viable (all scored -Infinity). Ties resolve to the earlier index
 * (DOM order), which favors the primary composer over later duplicates.
 */
export function pickComposer(descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) return -1;
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < descriptors.length; i++) {
    const s = scoreComposerCandidate(descriptors[i]);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  return bestScore === -Infinity ? -1 : bestIdx;
}
