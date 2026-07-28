// ===== COMPOSER LEARN (PURE) — self-learning composer identification =======
// LAYER 1.5. Shape scoring (composer-finder.js) survives renames/moves but can
// be fooled when two big editable boxes compete (a search box, a doc canvas) —
// "Case B". This module adds two stronger, evidence-based signals, both pure and
// headless-testable:
//
//   1. FOCUS at submit time — the editable box the user is actually typing in
//      when they submit IS the composer. This is a user action, not a guess, so
//      it beats shape scoring and needs no network call (never leaks).
//   2. A persisted FINGERPRINT of the box learned in (1) — so a later page load
//      recalls the same composer directly, even before the user focuses it,
//      surviving a Google redesign after exactly one learned submit.
//
// It composes with composer-finder.js: when neither focus nor a learned
// fingerprint applies, it falls back to the heuristic pickComposer.
//
// Why not correlate with the actual Gemini network request? Because the primary
// path KILLS the submit before any request fires (fail-closed), so there is no
// outbound request to observe without leaking. The focus-at-submit signal is the
// safe realization of the same "the box that drives a send is the composer" idea.
//
// Design ref: plan "Layer 1.5".

import { scoreComposerCandidate, pickComposer } from "./composer-finder.js";

// A class token looks build-generated (hashed) if it carries digits or is very
// short — those rotate per Google build and must NOT go in a fingerprint, or the
// fingerprint dies on the next deploy. Keep human-authored, stable-looking names.
function isStableClass(tok) {
  return typeof tok === "string" && tok.length >= 3 && !/[0-9_]/.test(tok);
}

/**
 * Build a serializable fingerprint of a composer from its descriptor. Stored
 * (via the bridge) and later matched against fresh candidates. Kept deliberately
 * loose (tag + role + label + a few stable classes) so a minor DOM tweak doesn't
 * break recall, but tag is required (a hard discriminator).
 */
export function makeFingerprint(desc) {
  if (!desc || typeof desc !== "object") return null;
  return {
    tag: desc.tag || "",
    role: desc.role || "",
    ariaLabel: (desc.ariaLabel || "").slice(0, 80),
    classTokens: Array.isArray(desc.classList) ? desc.classList.filter(isStableClass).slice(0, 8) : [],
  };
}

/**
 * Score how well a candidate descriptor matches a stored fingerprint. Higher is
 * better. Returns -Infinity on a tag mismatch (a hard discriminator) so a
 * different kind of element can never be recalled as the composer.
 */
export function scoreFingerprintMatch(desc, fp) {
  if (!desc || !fp) return -Infinity;
  if ((desc.tag || "") !== (fp.tag || "")) return -Infinity;
  let score = 0;
  if (fp.role && desc.role === fp.role) score += 3;
  if (fp.ariaLabel && (desc.ariaLabel || "").slice(0, 80) === fp.ariaLabel) score += 5;
  const have = new Set(Array.isArray(desc.classList) ? desc.classList : []);
  let shared = 0;
  for (const t of fp.classTokens || []) if (have.has(t)) shared++;
  score += Math.min(6, shared * 2);
  return score;
}

// A fingerprint recall is only trusted above this score (avoids a tag-only match
// with nothing else in common recalling the wrong element).
const FINGERPRINT_MIN_MATCH = 3;

/**
 * Decide which candidate is the composer, using the strongest available signal.
 * Priority: focused editable > learned fingerprint > heuristic shape.
 *
 * @param {{ activeIndex: number, descriptors: object[], learnedFingerprint: object|null }} args
 *   - activeIndex: index in `descriptors` of the currently-focused element, or -1
 *   - descriptors: candidate descriptors (as built by composer.js describeCandidate)
 *   - learnedFingerprint: a previously persisted fingerprint, or null
 * @returns {{ index: number, via: "focus"|"learned"|"heuristic", fingerprintToPersist: object|null }}
 *   index -1 means "found nothing" (caller must fail closed).
 */
export function chooseComposer({ activeIndex, descriptors, learnedFingerprint }) {
  const list = Array.isArray(descriptors) ? descriptors : [];

  // 1) FOCUS — the box the user is typing in, if it's a sane editable. Learn it.
  if (
    typeof activeIndex === "number" &&
    activeIndex >= 0 &&
    activeIndex < list.length &&
    scoreComposerCandidate(list[activeIndex]) > -Infinity
  ) {
    return { index: activeIndex, via: "focus", fingerprintToPersist: makeFingerprint(list[activeIndex]) };
  }

  // 2) LEARNED FINGERPRINT — recall the composer from a prior submit.
  if (learnedFingerprint) {
    let bestIdx = -1;
    let bestScore = FINGERPRINT_MIN_MATCH - 1;
    for (let i = 0; i < list.length; i++) {
      // Only consider sane editables; a matching-but-hidden node isn't usable.
      if (scoreComposerCandidate(list[i]) === -Infinity) continue;
      const s = scoreFingerprintMatch(list[i], learnedFingerprint);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) return { index: bestIdx, via: "learned", fingerprintToPersist: null };
  }

  // 3) HEURISTIC — shape-based fallback.
  return { index: pickComposer(list), via: "heuristic", fingerprintToPersist: null };
}
