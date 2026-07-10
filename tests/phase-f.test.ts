// ===== PHASE F — MCP + PROXY end-to-end (both work, together) ================
// Drives the REAL gateway against a local fake upstream. 3 e2e tests for the
// PROXY and 3 for the MCP server. The MCP happy path reads the proxy's LIVE
// traffic log, proving the two planes share in-process state.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createGatewayServer, trafficLog } from "../secure-llm-gateway.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";
import { freePort } from "./helpers/net.ts";

let upstream: FakeUpstream;
let server: ReturnType<typeof createGatewayServer>;
let base: string;
let deadPort: number;

before(async () => {
  upstream = await startFakeUpstream();
  deadPort = await freePort();
  server = createGatewayServer({
    upstreams: { openai: upstream.base, anthropic: upstream.base, gemini: upstream.base },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  await upstream.close();
});
beforeEach(() => trafficLog.clear());

const rpc = (msg: unknown) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg),
  }).then((r) => r.json());

const proxyPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

// ============================================================================
// PROXY — 3 e2e
// ============================================================================

// PROXY happy — bidirectional redaction + a well-formed log entry.
test("proxy happy: PII scrubbed inbound + outbound, entry logged", async () => {
  const res = await proxyPost("/openai/v1/chat/completions", {
    messages: [{ role: "user", content: "email real.user@corp.com ssn 123-45-6789" }],
  });
  assert.equal(res.status, 200);

  const sent = upstream.last()!.body;
  assert.doesNotMatch(sent, /real\.user@corp\.com/);
  assert.match(sent, /\[REDACTED_PII_EMAIL\]/);
  assert.match(sent, /\[REDACTED_PII_SSN\]/);

  const clientSaw = await res.text();
  assert.doesNotMatch(clientSaw, /mock\.person@fake-leak\.com/);
  assert.match(clientSaw, /\[REDACTED_MOCK_PII\]/);

  const e = trafficLog.recent(1, false)[0];
  assert.equal(e.provider, "openai");
  assert.equal(e.status, 200);
  assert.equal(e.piiDetected, true);
  assert.equal(e.matchedRules.inbound.EMAIL, 1);
  assert.equal(e.matchedRules.inbound.SSN, 1);
});

// PROXY failure — unreachable upstream surfaces as 502 and is logged.
test("proxy failure: upstream down -> 502 JSON, entry logged", async () => {
  const bad = createGatewayServer({
    upstreams: {
      openai: `http://127.0.0.1:${deadPort}`,
      anthropic: `http://127.0.0.1:${deadPort}`,
      gemini: `http://127.0.0.1:${deadPort}`,
    },
  });
  await new Promise<void>((r) => bad.listen(0, "127.0.0.1", r));
  const badBase = `http://127.0.0.1:${(bad.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${badBase}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 502);
    assert.ok((await res.json()).error);
    assert.ok(trafficLog.recent(100, false).some((e) => e.status === 502));
  } finally {
    bad.closeAllConnections?.();
    await new Promise<void>((r, j) => bad.close((e) => (e ? j(e) : r())));
  }
});

// PROXY edge — streaming SSE with PII fractured across chunks.
test("proxy edge: streaming email split across SSE chunks is redacted, framing valid", async () => {
  const res = await proxyPost(
    "/openai/v1/chat/completions",
    { stream: true, messages: [{ role: "user", content: "hi" }] },
    { "x-fake-mode": "sse" },
  );
  const body = await res.text();
  assert.doesNotMatch(body, /mock\.person@fake-leak\.com/);
  assert.match(body, /\[REDACTED_MOCK_PII\]/);
  for (const ev of body.split(/\r?\n\r?\n/).filter((e) => e.trim())) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (data && data !== "[DONE]") assert.doesNotThrow(() => JSON.parse(data));
  }
});

// ============================================================================
// MCP — 3 e2e
// ============================================================================

// MCP happy — full handshake, and get_traffic_logs reflects LIVE proxy traffic.
test("mcp happy: initialize -> tools/list -> tools/call reads the proxy's live log", async () => {
  // make a real proxied request so the log has a genuine entry
  await proxyPost("/anthropic/v1/messages", {
    messages: [{ role: "user", content: "reach me at live.user@corp.com" }],
  });

  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(init.result.serverInfo.name, "secure-llm-gateway");
  assert.ok(init.result.capabilities.tools);

  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok((list.result.tools as { name: string }[]).some((t) => t.name === "get_traffic_logs"));

  const call = await rpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_traffic_logs", arguments: { limit: 10 } },
  });
  const entries = JSON.parse(call.result.content[0].text);
  assert.ok(entries.length >= 1);
  assert.equal(entries[0].provider, "anthropic");
  assert.equal(entries[0].matchedRules.inbound.EMAIL, 1); // live proxy data, redacted
  // the tool output must never carry the raw address
  assert.doesNotMatch(call.result.content[0].text, /live\.user@corp\.com/);
});

// MCP failure — unknown method returns JSON-RPC -32601.
test("mcp failure: unknown method -> -32601", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 9, method: "does/not/exist" });
  assert.equal(res.error.code, -32601);
  assert.equal(res.id, 9);
});

// MCP edge — legacy HTTP+SSE transport: endpoint event + tools/call over stream.
test("mcp edge: legacy HTTP+SSE endpoint + tools/call delivered over the stream", async () => {
  await proxyPost("/openai/v1/chat/completions", { messages: [{ role: "user", content: "x" }] });

  // open the SSE stream (MUST send Accept: text/event-stream, else -> console HTML)
  const queue: any[] = [];
  const waiters: ((v: any) => void)[] = [];
  let endpoint = "";
  const req: http.ClientRequest = await new Promise((resolve, reject) => {
    const r = http.get(`${base}/mcp`, { headers: { accept: "text/event-stream" } }, (res) => {
      let buf = "";
      res.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let m: RegExpExecArray | null;
        while ((m = /\r?\n\r?\n/.exec(buf)) !== null) {
          const raw = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          let ev = "message";
          const dl: string[] = [];
          for (const line of raw.split(/\r?\n/)) {
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:")) dl.push(line.slice(5).trim());
          }
          const data = dl.join("\n");
          if (ev === "endpoint") { endpoint = data; resolve(r); }
          else if (data) {
            try {
              const j = JSON.parse(data);
              if (waiters.length) waiters.shift()!(j);
              else queue.push(j);
            } catch { /* ignore */ }
          }
        }
      });
    });
    r.on("error", reject);
  });

  try {
    assert.match(endpoint, /^\/mcp\/messages\?sessionId=/);
    const post = await fetch(`${base}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "get_traffic_logs", arguments: {} },
      }),
    });
    assert.equal(post.status, 202);
    const reply = await new Promise<any>((res2) => {
      if (queue.length) res2(queue.shift());
      else waiters.push(res2);
    });
    assert.equal(reply.id, 5);
    const entries = JSON.parse(reply.result.content[0].text);
    assert.ok(entries.length >= 1);
  } finally {
    req.destroy();
  }
});

// PROXY snapshot — the full redacted turn is captured, incl. trailing `system`.
test("proxy snapshot: log captures content far past 500 chars (system prompt visible)", async () => {
  const filler = "x".repeat(3000); // pushes the marker well beyond the old 500-char cap
  await proxyPost("/anthropic/v1/messages", {
    model: "claude-x",
    messages: [{ role: "user", content: filler }],
    system: [{ type: "text", text: "SYSTEM_PROMPT_MARKER contact ops@corp.com" }],
  });
  const e = trafficLog.recent(1, false)[0];
  assert.ok(e.payloadSnapshot.request.length > 3000, "snapshot is no longer clipped at 500");
  assert.match(e.payloadSnapshot.request, /SYSTEM_PROMPT_MARKER/); // the system prompt is captured
  assert.match(e.payloadSnapshot.request, /\[REDACTED_PII_EMAIL\]/); // still redacted
  assert.doesNotMatch(e.payloadSnapshot.request, /ops@corp\.com/);
});

// PROXY sanitize — empty text blocks are stripped before forwarding (fixes the
// Anthropic "text content blocks must be non-empty" 400 from replayed history).
test("proxy sanitize: empty text content blocks are removed before forwarding", async () => {
  await proxyPost("/anthropic/v1/messages", {
    model: "claude-x",
    system: [{ type: "text", text: "" }, { type: "text", text: "You are helpful" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "" }] }, // whole block empty
    ],
  });
  const sent = JSON.parse(upstream.last()!.body);
  // no empty text block survives anywhere
  const flat = JSON.stringify(sent);
  assert.doesNotMatch(flat, /"text":""/);
  // the real user text is preserved
  assert.equal(sent.messages[0].content.some((b: any) => b.text === "hello"), true);
  // the all-empty assistant block became a minimal non-empty placeholder (never [])
  assert.ok(sent.messages[1].content.length >= 1);
  assert.ok(sent.messages[1].content[0].text.length >= 1);
});
