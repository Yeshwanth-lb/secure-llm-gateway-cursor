// ===== PHASE J TESTS — Cursor OpenAI<->Anthropic translation shim ============
// Cursor exposes ONE global "Override OpenAI Base URL", so a single gateway
// endpoint (/openai/*) serves BOTH GPT (pass-through) and Claude (translated),
// routed by MODEL NAME:
//   - a "claude-*" id or a configured alias ("claude-via-gateway") -> translate
//     to the Anthropic Messages API, redact both ways, reshape reply to OpenAI.
//   - any other model ("gpt-4o", …) -> pass through to the OpenAI upstream.
// Drives the REAL gateway end-to-end against a local fake upstream.
//
// PII fixtures are built from fragments at runtime (no full literal in source).

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  createGatewayServer,
  trafficLog,
  setModelBlocked,
  resetModelPolicies,
} from "../secure-llm-gateway.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";

const EMAIL = "cursor.user" + "@" + "example.com"; // inbound, from the "client"
const MOCK = "mock.person" + "@" + "fake-leak.com"; // outbound, from the fake upstream

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

beforeEach(() => {
  trafficLog.clear();
  resetModelPolicies();
});

// --- HAPPY: model-routed translation AND pass-through on one endpoint ----------
test("happy: claude alias translates to Anthropic; gpt model passes through — one endpoint", async () => {
  // (A) TRANSLATE: model "claude-via-gateway" -> Anthropic, redacted both ways.
  const res = await fetch(`${base}/openai/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer sk-openai-fake",
      "x-fake-mode": "anthropic-json",
    },
    body: JSON.stringify({
      model: "claude-via-gateway",
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: `email me at ${EMAIL}` },
      ],
    }),
  });
  assert.equal(res.status, 200);

  const got = upstream.last()!;
  assert.equal(got.path, "/v1/messages"); // retargeted to the Anthropic endpoint
  const fwd = JSON.parse(got.body);
  assert.equal(fwd.model, "claude-sonnet-5"); // alias resolved to a real Claude model
  assert.ok(typeof fwd.max_tokens === "number" && fwd.max_tokens > 0);
  assert.equal(fwd.system, "you are helpful");
  assert.equal(got.body.includes(EMAIL), false, "real email must never leave the machine");
  assert.match(got.body, /\[REDACTED_PII_EMAIL\]/);
  assert.equal(got.headers["authorization"], undefined); // client bearer dropped
  assert.ok(got.headers["x-api-key"] && got.headers["anthropic-version"]);

  const body = (await res.json()) as any;
  assert.equal(body.object, "chat.completion");
  // Response echoes the CLIENT's requested id (the alias), not the resolved
  // Claude id — OpenAI-compatible clients (Cursor) validate a custom model by
  // matching the returned `model` against what they sent. Real routing to
  // claude-sonnet-5 is already asserted on the forwarded body above (line ~72).
  assert.equal(body.model, "claude-via-gateway");
  const content = body.choices[0].message.content as string;
  assert.equal(content.includes(MOCK), false);
  assert.match(content, /\[REDACTED_MOCK_PII\]/);

  // (B) PASS-THROUGH: model "gpt-4o" stays OpenAI — NOT translated.
  const res2 = await fetch(`${base}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fake-mode": "json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: `ping ${EMAIL}` }],
    }),
  });
  assert.equal(res2.status, 200);
  const got2 = upstream.last()!;
  assert.equal(got2.path, "/v1/chat/completions"); // NOT /v1/messages
  const fwd2 = JSON.parse(got2.body);
  assert.equal(fwd2.model, "gpt-4o"); // untouched
  assert.ok(Array.isArray(fwd2.messages)); // still OpenAI shape (not reshaped)
  assert.equal(fwd2.max_tokens, undefined); // no Anthropic fields injected
  assert.equal(got2.body.includes(EMAIL), false); // still redacted inbound
  const body2 = (await res2.json()) as any;
  assert.ok(body2.reply); // pass-through OpenAI-shaped response
  assert.equal(JSON.stringify(body2).includes(MOCK), false);

  // logs: one anthropic (translated) entry + one openai (pass-through) entry.
  const entries = trafficLog.recent(100, false);
  assert.ok(entries.some((e) => e.provider === "anthropic" && e.model === "claude-sonnet-5"));
  assert.ok(entries.some((e) => e.provider === "openai" && e.model === "gpt-4o"));
});

// --- FAILURE: bad request -> 400; blocked Claude model not reachable via alias --
test("failure: missing messages -> 400; blocked Claude model blocked under alias", async () => {
  // (1) translate request with no messages -> clean 400, nothing forwarded.
  const before = upstream.received.length;
  const bad = await fetch(`${base}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fake-mode": "anthropic-json" },
    body: JSON.stringify({ model: "claude-via-gateway" }), // no messages
  });
  assert.equal(bad.status, 400);
  assert.ok(((await bad.json()) as any).error?.message);
  assert.equal(upstream.received.length, before, "invalid request must not be forwarded");

  // (2) model-policy ordering fix: block the RESOLVED Claude model, then send a
  //     request under its alias — it must be rejected, not forwarded.
  assert.equal(setModelBlocked("claude-sonnet-5", true), true);
  const beforeBlocked = upstream.received.length;
  const blocked = await fetch(`${base}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fake-mode": "anthropic-json" },
    body: JSON.stringify({
      model: "claude-via-gateway", // resolves to the blocked claude-sonnet-5
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(blocked.status, 403);
  assert.equal(
    upstream.received.length,
    beforeBlocked,
    "a blocked Claude model must not be reachable under its alias",
  );
  const e = trafficLog.recent(100, false).find((x) => x.status === 403)!;
  assert.equal(e.blocked, true);
  assert.equal(e.model, "claude-sonnet-5");
});

// --- EDGE: streaming SSE, PII split across chunks, reframed to OpenAI ----------
test("edge: streaming Anthropic SSE with split PII is redacted + reframed to OpenAI", async () => {
  const res = await fetch(`${base}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fake-mode": "anthropic-sse" },
    body: JSON.stringify({
      model: "claude-via-gateway",
      stream: true,
      messages: [{ role: "user", content: "reply please" }],
    }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

  const text = await res.text();
  assert.match(text, /"object":"chat\.completion\.chunk"/);
  assert.match(text, /data: \[DONE\]/);
  let assembled = "";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const c = JSON.parse(payload).choices?.[0]?.delta?.content;
      if (typeof c === "string") assembled += c;
    } catch {
      /* skip */
    }
  }
  assert.equal(assembled.includes(MOCK), false, "split mock email must be scrubbed");
  assert.match(assembled, /\[REDACTED_MOCK_PII\]/);
  assert.match(assembled, /reply from/);
  assert.match(assembled, /ok/);

  const e = trafficLog.recent(100, false)[0];
  assert.equal(e.provider, "anthropic");
  assert.equal(e.streaming, true);
  assert.ok((e.matchedRules.outbound.EMAIL ?? 0) >= 1);
});

// --- REGRESSION: model-list validation endpoint (Cursor model verify) ----------
// Cursor validates a custom model by GETting /v1/models on its base URL. Proxying
// that to the real OpenAI upstream 401s on the dummy key and Cursor reports the
// model "not valid", blocking the chat. The gateway must answer locally with a
// synthetic list containing the translate alias(es). (Fix 2026-07-13.)
test("regression: GET /openai/v1/models is answered locally with translate aliases", async () => {
  const res = await fetch(`${base}/openai/v1/models`, {
    headers: { authorization: "Bearer sk-dummy" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { object: string; data: { id: string }[] };
  assert.equal(body.object, "list");
  const ids = body.data.map((m) => m.id);
  assert.ok(ids.includes("claude-via-gateway"), "must list the default translate alias");
  // Never proxied to the fake upstream (it would have recorded a log entry).
  assert.equal(trafficLog.recent(100, false).length, 0, "must not proxy the models probe");
});

// Cursor's base URL override may omit the `/openai` segment (set to the bare
// gateway root). Root chat already routes to the shim, so the models probe must
// also answer at the bare root — otherwise validation 404s while chat works,
// and Cursor reports the model "not valid" on send. (Fix 2026-07-13.)
test("regression: GET /v1/models and /models (no /openai prefix) answered locally", async () => {
  for (const p of ["/v1/models", "/models"]) {
    const res = await fetch(`${base}${p}`, { headers: { authorization: "Bearer sk-dummy" } });
    assert.equal(res.status, 200, `${p} must be 200`);
    const body = (await res.json()) as { object: string; data: { id: string }[] };
    assert.equal(body.object, "list");
    assert.ok(body.data.map((m) => m.id).includes("claude-via-gateway"), `${p} must list the alias`);
  }
  assert.equal(trafficLog.recent(100, false).length, 0, "must not proxy the root models probe");
});
