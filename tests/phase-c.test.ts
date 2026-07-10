// ===== PHASE C — INTEGRATION & ACCEPTANCE =====================================
// The 6 success criteria from PRD §7 / newplan §8 as the happy set, driven
// end-to-end through the REAL gateway + a local fake upstream + all 3 MCP
// transports — plus a failure/edge hardening trio (CLAUDE.md §4.1). Hermetic:
// no real network, all servers torn down in after().

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import {
  createGatewayServer,
  trafficLog,
  loadConfig,
  redactText,
  resetRedactionRules,
} from "../secure-llm-gateway.ts";
import type { LogEntry } from "../secure-llm-gateway.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";
import { freePort } from "./helpers/net.ts";

let upstream: FakeUpstream;
let server: ReturnType<typeof createGatewayServer>;
let base: string;

before(async () => {
  upstream = await startFakeUpstream();
  server = createGatewayServer({
    upstreams: { openai: upstream.base, anthropic: upstream.base, gemini: upstream.base },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  await upstream.close();
});

beforeEach(() => trafficLog.clear());

// ---- helpers ----------------------------------------------------------------

const rpc = (msg: unknown) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg),
  }).then((r) => r.json());

/** Read a whole SSE response body as text (stream ends on upstream [DONE]). */
async function readSseBody(res: Response): Promise<string> {
  return await res.text();
}

/** Minimal legacy-transport SSE client: opens GET /mcp, exposes the endpoint URL
 *  and a queue of JSON data events delivered over the stream. */
function openLegacySse(): Promise<{
  endpoint: string;
  nextData: () => Promise<any>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const queue: any[] = [];
    const waiters: ((v: any) => void)[] = [];
    let endpoint = "";
    const req = http.get(`${base}/mcp`, { headers: { accept: "text/event-stream" } }, (res) => {
      let buf = "";
      res.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let m: RegExpExecArray | null;
        while ((m = /\r?\n\r?\n/.exec(buf)) !== null) {
          const rawEvent = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          let evType = "message";
          const dataLines: string[] = [];
          for (const line of rawEvent.split(/\r?\n/)) {
            if (line.startsWith("event:")) evType = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          const data = dataLines.join("\n");
          if (evType === "endpoint") {
            endpoint = data;
            resolve({
              endpoint,
              nextData: () =>
                new Promise((res2) => {
                  if (queue.length) res2(queue.shift());
                  else waiters.push(res2);
                }),
              close: () => req.destroy(),
            });
          } else if (data) {
            let parsed: any;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            if (waiters.length) waiters.shift()!(parsed);
            else queue.push(parsed);
          }
        }
      });
    });
    req.on("error", reject);
  });
}

function seedEntry(id: string): LogEntry {
  return {
    id,
    timestamp: "2026-07-09T00:00:00.000Z",
    provider: "openai",
    method: "POST",
    path: "/openai/v1/chat/completions",
    status: 200,
    streaming: false,
    durationMs: 1,
    charCount: { request: 1, response: 1, total: 2 },
    payloadSnapshot: { request: "[REDACTED_PII_EMAIL]", response: "ok" },
    piiDetected: true,
    matchedRules: { inbound: { EMAIL: 1 }, outbound: {} },
  };
}

// ============================================================================
// ACCEPTANCE CRITERIA (PRD §7) — the happy set
// ============================================================================

// #1 — inbound email/SSN/CC/API-key -> upstream receives [REDACTED_PII_*].
test("acceptance #1: inbound PII scrubbed before any byte leaves the machine", async () => {
  const secrets = {
    email: "real.user@corp.com",
    ssn: "123-45-6789",
    card: "4111 1111 1111 1111",
    key: "sk-ant-api03-abcdefghijklmnop1234567890",
  };
  await fetch(`${base}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: JSON.stringify(secrets) }] }),
  });
  const got = upstream.last()!.body;
  assert.doesNotMatch(got, /real\.user@corp\.com/);
  assert.doesNotMatch(got, /123-45-6789/);
  assert.doesNotMatch(got, /4111 1111 1111 1111/);
  assert.doesNotMatch(got, /sk-ant-api03/);
  assert.match(got, /\[REDACTED_PII_EMAIL\]/);
  assert.match(got, /\[REDACTED_PII_SSN\]/);
  assert.match(got, /\[REDACTED_PII_CREDIT_CARD\]/);
  assert.match(got, /\[REDACTED_PII_API_KEY\]/);
});

// #2 — email split mid-string across SSE chunks -> [REDACTED_MOCK_PII], valid framing.
test("acceptance #2: outbound email fractured across SSE chunks is redacted with valid framing", async () => {
  const res = await fetch(`${base}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fake-mode": "sse" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const body = await readSseBody(res);
  // the fractured mock address never reassembled in the client's bytes
  assert.doesNotMatch(body, /mock\.person@fake-leak\.com/);
  assert.match(body, /\[REDACTED_MOCK_PII\]/);
  // every non-[DONE] data event is still valid JSON — no fractured payloads
  for (const ev of body.split(/\r?\n\r?\n/).filter((e) => e.trim())) {
    const data = ev
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (data && data !== "[DONE]") assert.doesNotThrow(() => JSON.parse(data));
  }
});

// #3 — PII in the final holdback window -> flush injected BEFORE the terminal event.
test("acceptance #3: withheld PII is flushed before the terminal [DONE]", async () => {
  const res = await fetch(`${base}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fake-mode": "sse" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const body = await readSseBody(res);
  const redactedAt = body.indexOf("[REDACTED_MOCK_PII]");
  const doneAt = body.indexOf("[DONE]");
  assert.ok(redactedAt >= 0, "redacted flush present");
  assert.ok(doneAt >= 0, "terminal [DONE] present");
  assert.ok(redactedAt < doneAt, "flush lands before the terminal event");
});

// #4 — MCP handshake + get_traffic_logs over ALL THREE transports.
test("acceptance #4a: MCP over Streamable HTTP (initialize -> tools/list -> tools/call)", async () => {
  trafficLog.clear();
  trafficLog.push(seedEntry("http-1"));
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(init.result.serverInfo.name, "secure-llm-gateway");
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok((list.result.tools as any[]).some((t) => t.name === "get_traffic_logs"));
  const call = await rpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_traffic_logs", arguments: { limit: 10 } },
  });
  const entries = JSON.parse(call.result.content[0].text) as LogEntry[];
  assert.equal(entries[0].id, "http-1");
});

test("acceptance #4b: MCP over legacy HTTP+SSE (endpoint event + tools/call over the stream)", async () => {
  trafficLog.clear();
  trafficLog.push(seedEntry("sse-1"));
  const client = await openLegacySse();
  assert.match(client.endpoint, /^\/mcp\/messages\?sessionId=/);
  try {
    const post = await fetch(`${base}${client.endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "get_traffic_logs", arguments: {} },
      }),
    });
    assert.equal(post.status, 202); // response comes back over the SSE stream
    const reply = await client.nextData();
    assert.equal(reply.id, 7);
    const entries = JSON.parse(reply.result.content[0].text) as LogEntry[];
    assert.equal(entries[0].id, "sse-1");
  } finally {
    client.close();
  }
});

test("acceptance #4c: MCP over stdio (tools/call round-trip, stdout protocol-pure)", async () => {
  const entry = fileURLToPath(new URL("../secure-llm-gateway.ts", import.meta.url));
  const port = await freePort();
  const child = spawn(process.execPath, ["--experimental-strip-types", entry, "--stdio"], {
    env: { ...process.env, GATEWAY_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_traffic_logs", arguments: {} } });

  const lines = await new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 8000);
    child.stdout.on("data", () => {
      const parts = stdout.split("\n").filter((l) => l.trim());
      if (parts.length >= 2) {
        clearTimeout(timer);
        resolve(parts);
      }
    });
  });
  child.stdin.end();
  child.kill();

  const byId = lines.map((l) => JSON.parse(l));
  assert.equal(byId[0].id, 1);
  assert.equal(byId[0].result.serverInfo.name, "secure-llm-gateway");
  const callResp = byId.find((m) => m.id === 2);
  assert.ok(callResp.result.content[0].text !== undefined, "tools/call returned content");
  // stdout stays protocol-pure; diagnostics went to stderr
  assert.doesNotMatch(stdout, /listening/i);
  assert.match(stderr, /listening/i);
});

// #5 — path-prefix, header, and heuristic routes each hit the right upstream.
test("acceptance #5: prefix / header / heuristic routing each resolves the right provider", async () => {
  trafficLog.clear();
  const before = upstream.received.length; // fake upstream accumulates across tests
  // Tier 1: path prefix
  await fetch(`${base}/gemini/v1beta/models/x:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [] }),
  });
  // Tier 2: explicit header
  await fetch(`${base}/whatever`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-llm-provider": "anthropic" },
    body: JSON.stringify({ x: 1 }),
  });
  // Tier 3: path heuristic
  await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  const providers = trafficLog.recent(100, false).map((e) => e.provider).sort();
  assert.deepEqual(providers, ["anthropic", "gemini", "openai"]);
  assert.equal(upstream.received.length - before, 3); // all three actually reached upstream
});

// #6 — credit-card false positives killed by Luhn.
test("acceptance #6: non-Luhn 16-digit passes through; valid Luhn is redacted", async () => {
  await fetch(`${base}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "bad 4111 1111 1111 1112 good 4111 1111 1111 1111" }),
  });
  const got = upstream.last()!.body;
  assert.match(got, /4111 1111 1111 1112/, "invalid Luhn left intact");
  assert.match(got, /\[REDACTED_PII_CREDIT_CARD\]/, "valid Luhn redacted");
  // exactly one redaction (the valid card), not two
  assert.equal((got.match(/\[REDACTED_PII_CREDIT_CARD\]/g) ?? []).length, 1);
});

// ============================================================================
// HARDENING (CLAUDE.md §4.1 failure/edge trio)
// ============================================================================

// FAILURE — malformed JSON body degrades to raw-text scrub, still forwarded, no 500.
test("hardening/failure: malformed JSON body degrades to raw-text scrub (no crash)", async () => {
  const res = await fetch(`${base}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ this is not valid json but leaks john.doe@example.com here",
  });
  assert.equal(res.status, 200);
  const got = upstream.last()!.body;
  assert.doesNotMatch(got, /john\.doe@example\.com/);
  assert.match(got, /\[REDACTED_PII_EMAIL\]/);
});

// EDGE — a zero-length-matching custom rule must not hang the redactor (§7 guard).
test("hardening/edge: zero-length custom regex does not infinite-loop", () => {
  const prevEnv = process.env.CUSTOM_REGEX_RULES;
  process.env.CUSTOM_REGEX_RULES = JSON.stringify([{ name: "ZEROLEN", pattern: "a*" }]);
  resetRedactionRules();
  try {
    // if the guard were missing this would spin forever; the test itself is the assert
    const r = redactText("banana with email john.doe@example.com", "inbound");
    assert.match(r.text, /\[REDACTED_PII_EMAIL\]/);
  } finally {
    if (prevEnv === undefined) delete process.env.CUSTOM_REGEX_RULES;
    else process.env.CUSTOM_REGEX_RULES = prevEnv;
    resetRedactionRules(); // restore default rules for any later test
  }
});

// EDGE — loopback-only: a non-loopback host is refused at config load (no cloud mode).
test("hardening/edge: loadConfig refuses a non-loopback host", () => {
  const prev = process.env.GATEWAY_HOST;
  process.env.GATEWAY_HOST = "0.0.0.0";
  try {
    assert.throws(() => loadConfig(), /loopback-only/);
    assert.throws(() => loadConfig({ host: "10.0.0.5" }), /loopback-only/);
  } finally {
    if (prev === undefined) delete process.env.GATEWAY_HOST;
    else process.env.GATEWAY_HOST = prev;
  }
});

// EDGE — the gateway binds loopback only by default, never 0.0.0.0 (PRD §3 perimeter).
test("hardening/edge: default host is 127.0.0.1, never 0.0.0.0", async () => {
  assert.equal(loadConfig().host, "127.0.0.1");
  const s = createGatewayServer();
  await new Promise<void>((r) => s.listen(0, loadConfig().host, r));
  try {
    const addr = s.address() as net.AddressInfo;
    assert.equal(addr.address, "127.0.0.1");
    assert.notEqual(addr.address, "0.0.0.0");
  } finally {
    await new Promise<void>((r, j) => s.close((e) => (e ? j(e) : r())));
  }
});
