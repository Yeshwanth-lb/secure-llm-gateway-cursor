// ===== PHASE B2 TESTS — proxy pipeline + traffic log =========================
// Drives the REAL gateway end-to-end against a local fake upstream. Asserts:
//  - inbound PII is scrubbed before it reaches the upstream,
//  - outbound (model-generated) PII is scrubbed before it reaches the client,
//  - a traffic-log entry is recorded with correct counts + matched rules,
//  - upstream failure surfaces as 502 and is still logged,
//  - no raw PII ever lands in a log snapshot.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
  deadPort = await freePort(); // a port with nothing listening -> connection refused
  server = createGatewayServer({
    upstreams: {
      openai: upstream.base,
      anthropic: upstream.base,
      gemini: upstream.base,
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  await upstream.close();
});

beforeEach(() => trafficLog.clear());

// --- HAPPY: bidirectional redaction + a well-formed log entry ------------------
test("happy: request scrubbed inbound, response scrubbed outbound, entry logged", async () => {
  const res = await fetch(`${base}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-x",
      messages: [{ role: "user", content: "email me at real.user@corp.com" }],
    }),
  });
  assert.equal(res.status, 200);

  // inbound: the upstream must NOT have seen the real address.
  const got = upstream.last()!;
  assert.doesNotMatch(got.body, /real\.user@corp\.com/);
  assert.match(got.body, /\[REDACTED_PII_EMAIL\]/);

  // outbound: the client must NOT see the model's mock address.
  const clientBody = await res.text();
  assert.doesNotMatch(clientBody, /mock\.person@fake-leak\.com/);
  assert.match(clientBody, /\[REDACTED_MOCK_PII\]/);

  // a single log entry with correct provider + matched rules on both directions.
  const entries = trafficLog.recent(100, false);
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.provider, "openai");
  assert.equal(e.status, 200);
  assert.equal(e.piiDetected, true);
  assert.equal(e.matchedRules.inbound.EMAIL, 1);
  assert.equal(e.matchedRules.outbound.EMAIL, 1);
  assert.ok(e.charCount.request > 0 && e.charCount.response > 0);
  assert.equal(e.charCount.total, e.charCount.request + e.charCount.response);
});

// --- FAILURE: upstream down -> 502 JSON, still logged --------------------------
test("failure: unreachable upstream returns 502 and logs the failed entry", async () => {
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
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(body.error, "502 carries an error field");

    const entries = trafficLog.recent(100, false);
    assert.ok(entries.some((e) => e.status === 502), "failed request was logged");
  } finally {
    await new Promise<void>((r, j) => bad.close((e) => (e ? j(e) : r())));
  }
});

// --- EDGE: no raw PII ever persists in a log snapshot -------------------------
test("edge: log snapshot of a PII-heavy request contains no raw PII", async () => {
  const secrets = {
    email: "victim@secret.com",
    ssn: "123-45-6789",
    card: "4111 1111 1111 1111",
    key: "sk-ant-api03-abcdefghijklmnop1234567890",
  };
  await fetch(`${base}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: JSON.stringify(secrets) }] }),
  });

  const e = trafficLog.recent(1, false)[0];
  const dump = JSON.stringify(e); // the ENTIRE entry, snapshots included
  assert.doesNotMatch(dump, /victim@secret\.com/);
  assert.doesNotMatch(dump, /123-45-6789/);
  assert.doesNotMatch(dump, /4111 1111 1111 1111/);
  assert.doesNotMatch(dump, /sk-ant-api03/);
  // the entry still records THAT pii was found.
  assert.equal(e.piiDetected, true);
  assert.ok(Object.keys(e.matchedRules.inbound).length > 0);
});
