// ===== PHASE G-RESPONSE — assistant-reply capture ===========================
// The Gemini side panel ships (at least) three different DOMs: semantic
// `appsElements` classes (gemini.google.com / Docs / Sheets / Slides) and two
// OBFUSCATED builds whose class names rotate every Google deploy (Gmail + Drive,
// and Chat). On the obfuscated surfaces no stable selector exists, so the
// assistant output was logged as "(none)" — the prompt row had no reply beside
// it in the Traffic Inspector.
//
// Capture there is by SHAPE instead: a non-interactive block that sits AFTER the
// user's own message and appeared with this turn and/or grew while the model
// streamed. Two layers, both covered here:
//   - response-finder.js — pure ranking (no DOM).
//   - response-capture.js — the DOM walk, exercised against a minimal DOM shim
//     below so it runs in the zero-dep Node runner. The live Gmail/Chat panels
//     remain browser-gated (extension/test/e2e/run-response.mts).
//
// The trio mirrors the failure that got an earlier class-name-free fallback
// REVERTED: a suggestion chip ("Show me my unread emails") logged as the
// assistant output. A wrong pairing in an audit log is worse than a blank one,
// so the scorer must prefer NOTHING over a low-confidence guess.

import test from "node:test";
import assert from "node:assert/strict";

import {
  scoreResponseCandidate,
  pickResponse,
  looksLikeMetadata,
  MIN_CONFIDENT_RESPONSE_LEN,
} from "../extension/src/response-finder.js";
import { createResponseCapture } from "../extension/src/response-capture.js";

// ---------------------------------------------------------------------------
// Metadata rejection (obfuscated Chat/Gmail/Drive panels)
// ---------------------------------------------------------------------------

test("looksLikeMetadata: sender/timestamp chrome is metadata; real replies are not", () => {
  // The exact garbage the widened scope logged live on Chat (2026-07-30):
  assert.equal(looksLikeMetadata("Ask Gemini , 1 min ,"), true);
  assert.equal(looksLikeMetadata("You , 1 min , super bro a , 1 min ,"), true);
  assert.equal(looksLikeMetadata("Gemini · 12 min"), true);
  assert.equal(looksLikeMetadata("You , 5:42 PM"), true);
  // A prior user message stamped with its timestamp (the second garbage form seen
  // live) — an isolated "1 min" piece gives it away even though the message text
  // dominates the length.
  assert.equal(looksLikeMetadata("my email is [REDACTED_PII_EMAIL] , 1 min ,"), true);
  assert.equal(looksLikeMetadata("had lunch? , 2 min"), true);
  // Real replies — a short one, a medium one WITH commas but no isolated stamp,
  // and a long one that merely mentions a time word — must NOT be metadata.
  assert.equal(looksLikeMetadata("Understood. Acknowledged."), false);
  assert.equal(looksLikeMetadata("Hello! How can I assist you today?"), false);
  assert.equal(looksLikeMetadata("Sure, I can help with that, no problem at all."), false);
  assert.equal(
    looksLikeMetadata(
      "Hi Yeshwanth, I'm here to help you stay on top of your day and get things done. I can assist with catching up on messages, scheduling meetings, or drafting emails. What can I help you with today?",
    ),
    false,
  );
  assert.equal(
    looksLikeMetadata("Sure — I'll remind you in about 5 minutes once the export finishes running."),
    false,
  );
});

test("scoreResponseCandidate rejects a metadataLike block even if it appeared this turn", () => {
  const meta = candidate({ textLen: 20, grew: false, growthSteps: 0, metadataLike: true });
  const reply = candidate({ textLen: 220, grew: true, metadataLike: false });
  assert.equal(scoreResponseCandidate(meta), -Infinity, "sender/timestamp row is never the reply");
  // And the real reply still wins the pick over the metadata row.
  assert.equal(pickResponse([meta, reply]), 1);
});

// ---------------------------------------------------------------------------
// Pure ranking
// ---------------------------------------------------------------------------

/** A viable reply candidate; individual tests override what they exercise. */
function candidate(over: Record<string, unknown> = {}) {
  return {
    textLen: 240,
    grew: true,
    growthSteps: 6,
    followsPrompt: true,
    containsPrompt: false,
    interactive: false,
    interactiveTextRatio: 0,
    appearedAfterSubmit: true,
    visible: true,
    ...over,
  };
}

test("response-finder happy: the streaming reply beats suggestion chips and stale blocks", () => {
  const reply = candidate({ textLen: 300, grew: true, growthSteps: 8 });
  // A chip: new and short, but interactive -> never the reply.
  const chip = candidate({ textLen: 24, grew: false, growthSteps: 0, interactive: true });
  // A chip LIST: not interactive itself, but nearly all its text sits inside chips.
  const chipList = candidate({
    textLen: 96,
    grew: false,
    growthSteps: 0,
    interactive: false,
    interactiveTextRatio: 0.95,
  });
  // Pre-existing footer ("Gemini can make mistakes…") — long enough to qualify,
  // but it neither appeared with this turn nor grew, so it must lose.
  const footer = candidate({
    textLen: 120,
    grew: false,
    growthSteps: 0,
    appearedAfterSubmit: false,
  });

  const picked = pickResponse([chip, chipList, footer, reply]);
  assert.equal(picked, 3, "the grown, non-interactive block should win");
  assert.equal(scoreResponseCandidate(chip), -Infinity);
  assert.equal(scoreResponseCandidate(chipList), -Infinity);
  assert.ok(scoreResponseCandidate(reply) > scoreResponseCandidate(footer));
});

test("response-finder failure: nothing trustworthy -> -1 (log a blank response, never a guess)", () => {
  // Only chips + the user's own echoed prompt + a short stale line are present.
  const chip = candidate({ interactive: true, textLen: 30, grew: false, growthSteps: 0 });
  const echo = candidate({ containsPrompt: true, grew: false, growthSteps: 0 });
  const stale = candidate({
    grew: false,
    growthSteps: 0,
    appearedAfterSubmit: false,
    textLen: MIN_CONFIDENT_RESPONSE_LEN - 1,
  });
  // A block BEFORE the user's message is a previous turn -> would mispair.
  const previousTurn = candidate({ followsPrompt: false });

  assert.equal(pickResponse([chip, echo, stale, previousTurn]), -1);
  assert.equal(pickResponse([]), -1);
  assert.equal(pickResponse(null as never), -1);
});

test("response-finder edge: a short non-streaming reply still counts; chip-heavy wrapper loses to the pure block", () => {
  // Workspace panels sometimes render the whole reply in one paint (no growth
  // observed). Appearing with this turn is enough confidence on its own.
  const shortReply = candidate({ textLen: 12, grew: false, growthSteps: 0 });
  assert.ok(scoreResponseCandidate(shortReply) > -Infinity, "a new short reply is still a reply");

  // A hidden node with the same shape is not what the user saw.
  assert.equal(scoreResponseCandidate(candidate({ visible: false })), -Infinity);

  // The reply's own container (reply + chips appended after it) is longer than
  // the reply block, so length alone would pick it and drag chip text into the
  // audit row. Interactive-text purity must break that tie toward the reply.
  const replyBlock = candidate({ textLen: 300, interactiveTextRatio: 0 });
  const replyPlusChips = candidate({ textLen: 396, interactiveTextRatio: 96 / 396 });
  assert.equal(pickResponse([replyPlusChips, replyBlock]), 1);
});

// ---------------------------------------------------------------------------
// Minimal DOM shim — just enough of the element API that response-capture.js
// uses, so the traversal (anchoring, document order, chip rejection, growth
// tracking) is verified hermetically with zero dependencies. Real panels are
// verified in the browser e2e.
// ---------------------------------------------------------------------------

type Attrs = Record<string, string>;

class El {
  tag: string;
  attrs: Attrs;
  children: El[] = [];
  parentElement: El | null = null;
  hidden = false;
  private own = "";

  constructor(tag: string, attrs: Attrs = {}, text = "") {
    this.tag = tag;
    this.attrs = attrs;
    this.own = text;
  }

  append(...kids: El[]) {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }

  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join(" ") : this.own;
  }
  set textContent(v: string) {
    this.children = [];
    this.own = v;
  }
  get innerText(): string {
    return this.textContent;
  }
  get isConnected(): boolean {
    let el: El | null = this;
    while (el.parentElement) el = el.parentElement;
    return el.tag === "body";
  }
  get offsetParent(): El | null {
    return this.hidden ? null : this.parentElement;
  }
  getClientRects() {
    return this.hidden ? [] : [{ width: 100, height: 20 }];
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  contains(other: El): boolean {
    if (other === this) return true;
    return this.children.some((c) => c.contains(other));
  }
  descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  compareDocumentPosition(other: El): number {
    let root: El = this;
    while (root.parentElement) root = root.parentElement;
    const order = [root, ...root.descendants()];
    return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
  }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => matchOne(this, part.trim()));
  }
  closest(selector: string): El | null {
    let el: El | null = this;
    while (el) {
      if (el.matches(selector)) return el;
      el = el.parentElement;
    }
    return null;
  }
  querySelectorAll(selector: string): El[] {
    if (selector.trim() === "*") return this.descendants();
    return this.descendants().filter((d) => d.matches(selector));
  }
  /** Leaf elements stand in for text nodes (see makeDoc's createTreeWalker). */
  textNodes(): { nodeValue: string; parentElement: El }[] {
    return this.descendants()
      .filter((d) => d.children.length === 0 && d.textContent !== "")
      .map((d) => ({ nodeValue: d.textContent, parentElement: d }));
  }
}

/**
 * `document` stand-in. With `treeWalker` it exposes createTreeWalker, which is
 * response-capture's fast path for locating the prompt (the one that runs in
 * Chrome); without it, the element-scan fallback is exercised instead. Both must
 * find the same anchor.
 */
function makeDoc(body: El, treeWalker: boolean) {
  const doc: Record<string, unknown> = { body, defaultView: { NodeFilter: { SHOW_TEXT: 4 } } };
  if (treeWalker) {
    doc.createTreeWalker = (rootEl: El) => {
      const nodes = rootEl.textNodes();
      let i = -1;
      return {
        get currentNode() {
          return nodes[i];
        },
        nextNode() {
          return ++i < nodes.length ? nodes[i] : null;
        },
      };
    };
  }
  return doc as unknown as Document;
}

/** Supports the shapes response-capture.js actually uses: `tag`, `[a="v"]`, `tag[a]`. */
function matchOne(el: El, sel: string): boolean {
  if (sel === "*") return true;
  const m = /^([a-z]*)((?:\[[^\]]+\])*)$/.exec(sel);
  if (!m) return false;
  const [, tag, attrPart] = m;
  if (tag && el.tag !== tag) return false;
  for (const attr of attrPart.match(/\[[^\]]+\]/g) ?? []) {
    const eq = /^\[([^=\]]+)="([^"]*)"\]$/.exec(attr);
    if (eq) {
      if (el.getAttribute(eq[1]) !== eq[2]) return false;
    } else {
      const name = attr.slice(1, -1);
      if (el.getAttribute(name) === null) return false;
    }
  }
  return true;
}

const div = (attrs: Attrs = {}, text = "") => new El("div", attrs, text);

const PROMPT = "summarize the thread and list the owners";
const REPLY =
  "Sure. Here is a summary of the thread you asked about, including the next steps the team agreed on.";
const CHIPS = ["Show me my unread emails", "Summarize this thread", "Show fewer suggestions"];

/**
 * A Gmail/Drive-shaped panel: rotating (meaningless) class names, the user's
 * bubble, then a reply block, then suggestion chips as sibling listitems.
 */
function obfuscatedPanel({ treeWalker = true } = {}) {
  const body = new El("body");
  const composer = div({ contenteditable: "true", "aria-label": "Ask Gemini" }, "");
  const feed = div({ class: "xk3Ab" });
  const footer = div({}, "Gemini can make mistakes, so double-check its responses before relying on them.");
  body.append(feed, composer, footer);
  const doc = makeDoc(body, treeWalker);

  const addUserBubble = () => {
    const row = div({ class: "x9Ab", role: "listitem" });
    row.append(div({ class: "xB2c" }, PROMPT));
    feed.append(row);
    return row;
  };
  const addReply = (text: string) => {
    const row = div({ class: "xQ7z", role: "listitem" });
    const bodyEl = div({ class: "xR8y" }, text);
    row.append(bodyEl);
    feed.append(row);
    return bodyEl;
  };
  const addChips = () => {
    const list = div({ class: "xL1m", role: "list" });
    for (const label of CHIPS) {
      const item = div({ class: "xN4p", role: "listitem" });
      item.append(new El("button", { class: "xC5q" }, label));
      list.append(item);
    }
    feed.append(list);
  };
  return { doc, composer, addUserBubble, addReply, addChips };
}

/** Both anchor strategies must behave identically. */
for (const treeWalker of [true, false]) {
  test(`response-capture happy (${treeWalker ? "text-node fast path" : "element-scan fallback"}): the streamed reply is captured, not a chip`, () => {
    const panel = obfuscatedPanel({ treeWalker });
    const cap = createResponseCapture(PROMPT, panel.doc, panel.composer);
    cap.sample(true);
    panel.addUserBubble();
    cap.sample(true);
    const replyEl = panel.addReply(REPLY);
    cap.sample(true);
    panel.addChips();
    cap.sample(true);
    const captured = cap.read();
    assert.ok(captured.includes("summary of the thread"), `got: ${captured}`);
    assert.ok(!/unread emails|fewer suggestions/.test(captured), `chip text leaked into: ${captured}`);
    assert.equal(replyEl.textContent, REPLY);
  });
}

test("response-capture happy: on an obfuscated panel the streamed reply is captured, not a chip", () => {
  const panel = obfuscatedPanel();
  const cap = createResponseCapture(PROMPT, panel.doc, panel.composer);

  cap.sample(true); // baseline: the user's message hasn't rendered yet
  panel.addUserBubble();
  cap.sample(true); // anchor found; footer is now known to be pre-existing
  assert.equal(cap.hasCandidate(), false, "no reply yet -> nothing to log");

  // The model streams: the same block gets longer on each pass.
  const words = REPLY.split(" ");
  const replyEl = panel.addReply(words.slice(0, 4).join(" "));
  cap.sample(true);
  for (let n = 8; n <= words.length; n += 8) {
    replyEl.textContent = words.slice(0, n).join(" ");
    cap.sample(true);
  }
  panel.addChips(); // chips land after the reply, as Gmail does it
  cap.sample(true);

  assert.equal(cap.hasCandidate(), true);
  const captured = cap.read();
  assert.ok(captured.includes("summary of the thread"), `got: ${captured}`);
  assert.ok(!/unread emails|fewer suggestions/.test(captured), `chip text leaked into: ${captured}`);
  assert.ok(!captured.includes(PROMPT), `prompt echoed as the reply: ${captured}`);
  assert.ok(!captured.includes("double-check"), `page footer captured as the reply: ${captured}`);
});

test("response-capture failure: only chips (or no anchor at all) -> empty, never a guess", () => {
  const panel = obfuscatedPanel();
  const cap = createResponseCapture(PROMPT, panel.doc, panel.composer);
  cap.sample(true);
  panel.addUserBubble();
  cap.sample(true);
  panel.addChips();
  cap.sample(true);
  assert.equal(cap.hasCandidate(), false);
  assert.equal(cap.read(), "", "a suggestion chip must never be logged as the assistant output");

  // The prompt never appears in the DOM (send failed / different surface) -> the
  // anchor can't be resolved, so there is nothing to pair and nothing is logged.
  const orphan = obfuscatedPanel();
  const noAnchor = createResponseCapture("a prompt that was never rendered", orphan.doc, orphan.composer);
  orphan.addReply(REPLY);
  noAnchor.sample(true);
  assert.equal(noAnchor.read(), "");
});

test("response-capture edge: a reply from the PREVIOUS turn is never paired with this prompt", () => {
  const panel = obfuscatedPanel();
  // Turn 1 already happened: an old prompt and its (long) reply are on screen.
  panel.addUserBubble();
  const stale = panel.addReply("An older answer about last quarter's numbers that is quite long indeed.");
  panel.addChips();

  // Turn 2: our prompt renders below. The stale reply precedes it in document
  // order, so it must be excluded even though it is long and non-interactive.
  const cap = createResponseCapture(PROMPT, panel.doc, panel.composer);
  cap.sample(true);
  const bubble = panel.addUserBubble();
  cap.sample(true);
  assert.equal(cap.read(), "", "nothing after our prompt yet");

  // A hidden reply is not what the user saw either.
  const hiddenReply = panel.addReply(REPLY);
  hiddenReply.hidden = true;
  hiddenReply.parentElement!.hidden = true;
  cap.sample(true);
  assert.equal(cap.read(), "");

  // Once a visible reply lands after our bubble, that one is captured.
  const fresh = panel.addReply(REPLY);
  cap.sample(true);
  const captured = cap.read();
  assert.ok(captured.includes("summary of the thread"), `got: ${captured}`);
  assert.ok(!captured.includes("last quarter"), `stale turn captured: ${captured}`);
  assert.ok(bubble.textContent.includes(PROMPT) && stale.textContent.includes("last quarter"));
  assert.ok(fresh.isConnected);
});
