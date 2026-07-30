// ===== RESPONSE FINDER (PURE) — identify the assistant reply by SHAPE ========
// Companion to composer-finder.js, for the OTHER end of a turn. Selector-based
// reply capture only works where Google ships semantic markup: gemini.google.com
// and the `appsElements` side panel (Docs/Sheets/Slides) — see
// RESPONSE_SELECTORS in composer.js. Gmail, Drive and Chat render the same panel
// with class names that rotate every deploy, so there is nothing stable to
// select and those surfaces logged "(none)" for the assistant output.
//
// This module ranks candidate blocks by shape instead, using signals that do not
// depend on any class name:
//   - it must sit AFTER the user's own message in document order (so a previous
//     turn's reply can never be mispaired with this prompt),
//   - it must not be (or live inside) an interactive control, and most of its
//     text must not sit inside one — that is what a suggestion chip looks like,
//   - it should have APPEARED with this turn and/or GROWN while the model
//     streamed. Growth is the strongest tell: a reply arrives token by token,
//     whereas chips and disclaimers are inserted fully formed.
//
// A class-name-free fallback was tried and reverted once before because a
// "last [role=listitem]" heuristic reliably grabbed a suggestion chip. So the
// disqualifiers here are deliberately strict: when no candidate clears the
// confidence bar, `pickResponse` returns -1 and the caller logs an EMPTY
// response. A wrong pairing in an audit log is worse than a blank one.
//
// No DOM access lives here — extension/src/response-capture.js maps live
// elements to these descriptors, so the ranking stays headlessly testable
// (tests/phase-gemini-response.test.ts).

/** Shortest text we will consider a reply at all. */
export const MIN_RESPONSE_LEN = 2;

/**
 * A block that neither appeared with this turn nor grew needs at least this
 * much text before we will believe it is the reply. Below the bar we prefer a
 * blank response over a guess (a page footer, a stale label…).
 */
export const MIN_CONFIDENT_RESPONSE_LEN = 80;

/** Above this share of text sitting inside buttons/links, it's a chip list. */
const MAX_INTERACTIVE_TEXT_RATIO = 0.5;

/**
 * Static page CHROME that Gemini renders on every surface — the privacy/disclaimer
 * footer and the composer placeholder — never an actual reply. It is always present
 * (so it never "appeared after submit" or "grew"), long enough to clear the
 * confidence floor, and non-interactive, so shape capture would otherwise pick it
 * when the semantic selectors momentarily read empty — observed live on Firefox
 * gemini.google.com, where the log caught "…chats aren't used to improve our
 * models… Opens in a new window" instead of the answer. Pure/exported; unit-tested.
 */
const BOILERPLATE_RE =
  /gemini (is ai and |can )?(can )?make mistakes|chats?\s+(aren'?t|are not)\s+used to improve|opens in a new window|your privacy\s*&\s*gemini|double[- ]check (its|it'?s) responses|ask gemini/i;

export function looksLikeBoilerplate(text) {
  return BOILERPLATE_RE.test((text || "").replace(/\s+/g, " "));
}

/** A single comma/newline-separated piece that is a sender label or a timestamp,
 *  never reply content. */
const META_PIECE =
  /^(you|ask gemini|gemini|now|today|yesterday|mon|tue|wed|thu|fri|sat|sun|show thinking|model thoughts|\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?|\d+\s*(sec|second|min|minute|hour|hr|day|week|month)s?(\s+ago)?)$/i;

/**
 * True when a block is just conversation-list CHROME — sender names + timestamps
 * (+ maybe a stray short fragment) — not an actual message. On the obfuscated
 * panels (Chat/Gmail/Drive) the reply's container is wrapped by list rows whose
 * text reads like "Ask Gemini , 1 min ," or "You , 12 min ,"; without this those
 * got logged AS the reply. Only fires on SHORT blocks so a real reply that merely
 * contains a time word ("in about 5 minutes") is never rejected. Pure/exported so
 * it's unit-tested off-DOM; response-capture feeds it each candidate's text.
 */
export function looksLikeMetadata(text) {
  const n = (text || "").replace(/\s+/g, " ").trim();
  if (!n) return false;
  const pieces = n.split(/[,\n·|]+/).map((s) => s.trim()).filter(Boolean);
  if (pieces.length === 0) return false;
  const meta = pieces.filter((p) => META_PIECE.test(p)).length;
  // (a) a SHORT block that is mostly sender/timestamp fragments.
  if (n.length < 60 && meta >= Math.ceil(pieces.length * 0.6)) return true;
  // (b) ANY isolated sender/timestamp fragment in a non-long block ⇒ a message-
  //     LIST row: a bubble stamped with its own "1 min" / "Ask Gemini". A clean
  //     reply never has "1 min" as its OWN delimited piece; it only appears when
  //     we've grabbed a list row (often the user's NEXT message + its stamp,
  //     which mispairs). The length guard lets a long reply that merely lists a
  //     time ("in about 5 minutes") through untouched.
  if (n.length < 200 && meta >= 1) return true;
  return false;
}

/**
 * Score one candidate. Higher = more likely to be the assistant reply.
 * -Infinity means "cannot be the reply", so the caller can treat a best score
 * of -Infinity as "found nothing".
 *
 * descriptor = {
 *   textLen: number,              // visible text length
 *   grew: boolean,                // text got longer after we first saw it (streaming)
 *   growthSteps: number,          // how many times it grew
 *   followsPrompt: boolean,       // strictly after the user's message in doc order
 *   containsPrompt: boolean,      // echoes the prompt (the user's own bubble / an ancestor)
 *   interactive: boolean,         // is, or sits inside, a button/link/menuitem
 *   interactiveTextRatio: number, // share of its text inside interactive descendants
 *   appearedAfterSubmit: boolean, // was not present when the turn started
 *   visible: boolean,             // has layout
 *   metadataLike: boolean,        // just sender/timestamp chrome (looksLikeMetadata)
 *   boilerplateLike: boolean,     // Gemini privacy footer / placeholder (looksLikeBoilerplate)
 * }
 */
export function scoreResponseCandidate(d) {
  if (!d || typeof d !== "object") return -Infinity;
  // Hard disqualifiers.
  if (!d.visible) return -Infinity;
  if (!d.followsPrompt) return -Infinity; // an earlier turn — would mispair
  if (d.containsPrompt) return -Infinity; // the user's own message, or a wrapper of it
  if (d.interactive) return -Infinity; // a chip / button / link
  if ((d.interactiveTextRatio || 0) > MAX_INTERACTIVE_TEXT_RATIO) return -Infinity; // chip list
  if (d.metadataLike) return -Infinity; // sender label + timestamp row, not the reply
  if (d.boilerplateLike) return -Infinity; // Gemini's privacy footer / placeholder, not the reply
  if (typeof d.textLen !== "number" || d.textLen < MIN_RESPONSE_LEN) return -Infinity;
  // Confidence bar: something that was already on the page and never changed is
  // only believable as a reply if it is substantial.
  if (!d.grew && !d.appearedAfterSubmit && d.textLen < MIN_CONFIDENT_RESPONSE_LEN) return -Infinity;

  let score = 0;
  if (d.grew) score += 100 + Math.min(20, (d.growthSteps || 1) * 4); // streamed in
  if (d.appearedAfterSubmit) score += 30; // rendered as part of this turn
  score += Math.min(60, Math.log2(d.textLen) * 6); // longer blocks read like a reply
  // Purity: the reply's container (reply + chips appended below it) is LONGER
  // than the reply itself, so length alone would pull chip text into the log.
  score -= (d.interactiveTextRatio || 0) * 40;
  return score;
}

/**
 * Rank descriptors and return the index of the best reply candidate, or -1 when
 * none clears the bar (caller logs an empty response). Ties resolve to the
 * earlier index (document order).
 */
export function pickResponse(descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) return -1;
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < descriptors.length; i++) {
    const s = scoreResponseCandidate(descriptors[i]);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  return bestScore === -Infinity ? -1 : bestIdx;
}
