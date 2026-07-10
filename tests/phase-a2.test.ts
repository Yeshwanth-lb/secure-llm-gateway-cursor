// ===== PHASE A2 TESTS — StreamRedactor (SSE framing, holdback, flush) =========
// Drives the real StreamRedactor with synthetic OpenAI-shaped SSE. Zero deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamRedactor } from "../secure-llm-gateway.ts";

// Parse an SSE blob into events; return the concatenated OpenAI delta text and
// the raw event list (so we can assert framing + ordering).
function parseSse(out: string): { events: string[]; text: string; doneIdx: number } {
  const events = out.split(/\r?\n\r?\n/).filter((e) => e.trim() !== "");
  let text = "";
  let doneIdx = -1;
  events.forEach((ev, i) => {
    const data = ev
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (data === "[DONE]") {
      doneIdx = i;
      return;
    }
    try {
      const j = JSON.parse(data);
      const c = j?.choices?.[0]?.delta?.content;
      if (typeof c === "string") text += c;
    } catch {
      /* non-JSON data line — ignore for text accounting */
    }
  });
  return { events, text, doneIdx };
}

const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

// --- HAPPY: clean stream passes through, valid framing, text preserved --------
test("happy: clean SSE stream round-trips with valid framing and full text", () => {
  const sr = new StreamRedactor("openai", 96);
  let out = "";
  out += sr.push(Buffer.from(delta("Hello, ")));
  out += sr.push(Buffer.from(delta("world!")));
  out += sr.push(Buffer.from(DONE));
  out += sr.flush();

  const { text, doneIdx, events } = parseSse(out);
  assert.equal(text, "Hello, world!");
  assert.ok(doneIdx >= 0, "[DONE] terminal preserved");
  // every emitted event is well-formed (data: line present)
  for (const ev of events) assert.match(ev, /^data:/m);
});

// --- FAILURE: malformed JSON in a data: event must not crash ------------------
test("failure: partial/bad JSON in a data event does not crash the redactor", () => {
  const sr = new StreamRedactor("openai", 96);
  let out = "";
  assert.doesNotThrow(() => {
    out += sr.push(Buffer.from("data: {broken json not closed\n\n"));
    out += sr.push(Buffer.from(delta("ok after")));
    out += sr.push(Buffer.from(DONE));
    out += sr.flush();
  });
  // stream still terminates and the good text survives
  assert.match(out, /\[DONE\]/);
  assert.match(out, /ok after/);
});

// --- EDGE: email split across 3 chunks -> redacted, flushed before terminal ---
test("edge: email split across 3 chunks is redacted, flushed before [DONE], nothing dropped", () => {
  const sr = new StreamRedactor("openai", 96);
  let out = "";
  // "my email is john.doe@example.com now" fractured mid-address across chunks
  out += sr.push(Buffer.from(delta("my email is john.d")));
  out += sr.push(Buffer.from(delta("oe@examp")));
  out += sr.push(Buffer.from(delta("le.com now")));
  out += sr.push(Buffer.from(DONE));
  out += sr.flush();

  const { text, doneIdx, events } = parseSse(out);

  // raw email never leaked in any byte of the output
  assert.doesNotMatch(out, /john\.doe@example\.com/);
  // outbound token present in the reconstructed text
  assert.match(text, /\[REDACTED_MOCK_PII\]/);
  // surrounding non-PII text preserved, nothing dropped
  assert.match(text, /^my email is /);
  assert.match(text, / now$/);

  // the flushed PII text was emitted BEFORE the terminal [DONE] event
  const doneOrLater = events.slice(doneIdx);
  assert.ok(
    !doneOrLater.some((e) => /REDACTED_MOCK_PII/.test(e)),
    "redacted flush lands before [DONE], not after",
  );
  assert.ok(doneIdx >= 0, "terminal [DONE] still present");
});

// --- REGRESSION: Anthropic flush must keep its `event:` line ------------------
// A short response held entirely in the holdback window is released only at
// flush. That synthetic delta MUST carry `event: content_block_delta`, or an
// event-name-dispatching client (Claude Code) drops it and records an empty
// text block -> next turn fails with Anthropic 400 "text content blocks must be
// non-empty". Guards that exact bug.
test("regression: anthropic synthetic flush delta keeps its SSE event line", () => {
  const sr = new StreamRedactor("anthropic", 96);
  const ev = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const stream = [
    ev({ type: "message_start", message: { id: "m1", role: "assistant", content: [] } }),
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } }),
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } }),
    ev({ type: "content_block_stop", index: 0 }),
    ev({ type: "message_stop" }),
  ];
  let out = "";
  for (const c of stream) out += sr.push(Buffer.from(c));
  out += sr.flush();

  // reconstruct assistant text the way an event-dispatching client does:
  // only accept content_block_delta events that actually declare `event:`.
  let text = "";
  for (const block of out.split(/\r?\n\r?\n/).filter((b) => b.trim())) {
    const lines = block.split(/\r?\n/);
    const evName = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (evName !== "content_block_delta" || !data) continue;
    const j = JSON.parse(data);
    if (j.delta?.text) text += j.delta.text;
  }
  assert.equal(text, "Hi there", "no delta dropped for lack of an event line");
  // every content_block_delta event in the output declares an `event:` line
  for (const block of out.split(/\r?\n\r?\n/).filter((b) => b.trim())) {
    if (/"type":"content_block_delta"/.test(block)) {
      assert.match(block, /event: content_block_delta/, "flush delta carries its event line");
    }
  }
});
