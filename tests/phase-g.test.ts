// ===== PHASE G — CLEAN VIEW (strip Claude boilerplate) =======================
// The "strip Claude boilerplate" button: distill a log entry down to the real
// user prompt + assistant output. Unit tests on the pure extractors + an e2e
// check that GET /logs?clean=1 attaches the cleaned view.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  createGatewayServer,
  trafficLog,
  extractUserPrompt,
  extractAssistantOutput,
} from "../secure-llm-gateway.ts";
import type { LogEntry } from "../secure-llm-gateway.ts";

// --- UNIT: user prompt is extracted with system-reminder/CLAUDE.md stripped ---
test("happy: extractUserPrompt drops <system-reminder> boilerplate, keeps user text", () => {
  const req = JSON.stringify({
    model: "claude-x",
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI." }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\n# claudeMd\nlots of injected context...\n</system-reminder>\nwrite me a haiku" },
        ],
      },
    ],
  });
  const out = extractUserPrompt(req);
  assert.equal(out, "write me a haiku");
  assert.doesNotMatch(out, /claudeMd|system-reminder|Claude Code/);
});

// --- UNIT: assistant output reassembled from Anthropic SSE deltas -------------
test("happy: extractAssistantOutput concatenates Anthropic SSE text deltas", () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"role":"assistant"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}',
    "data: [DONE]",
  ].join("\n\n");
  assert.equal(extractAssistantOutput("anthropic", sse), "Hello world");
});

// --- FAILURE/EDGE: truncated request JSON degrades to a clear note, no throw --
test("edge: truncated request snapshot degrades gracefully (no throw)", () => {
  let out = "";
  assert.doesNotThrow(() => {
    out = extractUserPrompt('{"messages":[{"role":"user","content":"unterminated ...');
  });
  assert.match(out, /truncated|could not parse/i);
});

// --- E2E: GET /logs?clean=1 attaches { userPrompt, assistantOutput } ----------
let server: ReturnType<typeof createGatewayServer>;
let base: string;
before(async () => {
  server = createGatewayServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});
beforeEach(() => trafficLog.clear());

test("e2e: /logs?clean=1 returns stripped user prompt + assistant output", async () => {
  const entry: LogEntry = {
    id: "g1",
    timestamp: "2026-07-10T00:00:00.000Z",
    provider: "anthropic",
    method: "POST",
    path: "/v1/messages",
    status: 200,
    streaming: true,
    durationMs: 1,
    charCount: { request: 1, response: 1, total: 2 },
    payloadSnapshot: {
      request: JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>junk</system-reminder>summarize this" }] }],
      }),
      response:
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Done."}}\n\ndata: [DONE]\n\n',
    },
    piiDetected: false,
    matchedRules: { inbound: {}, outbound: {} },
  };
  trafficLog.push(entry);

  const plain = await (await fetch(`${base}/logs`)).json();
  assert.equal(plain.entries[0].clean, undefined); // no clean view without the flag

  const cleaned = await (await fetch(`${base}/logs?clean=1`)).json();
  const c = cleaned.entries[0].clean;
  assert.equal(c.userPrompt, "summarize this");
  assert.equal(c.assistantOutput, "Done.");
});
