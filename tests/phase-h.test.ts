// ===== PHASE H — MODEL POLICY (block by model) ===============================
// The Model Policy tab: toggle models to block. A blocked model is rejected
// with 403 at the proxy — the request is NEVER forwarded upstream — and the
// block is logged. Toggles are live via /api/models/toggle.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createGatewayServer, trafficLog, resetModelPolicies } from "../secure-llm-gateway.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";

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
  server.closeAllConnections?.();
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  await upstream.close();
});
beforeEach(() => {
  trafficLog.clear();
  resetModelPolicies();
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const sendModel = (model: string) =>
  post("/anthropic/v1/messages", { model, messages: [{ role: "user", content: "hi" }] });

// --- HAPPY: blocking a model returns 403 and never forwards -------------------
test("happy: blocking Opus 4.8 rejects the request with 403, upstream never hit", async () => {
  const before = upstream.received.length;
  // find the "Opus 4.8" policy id from live state
  const st = await (await fetch(`${base}/api/state`)).json();
  const opus = (st.models as any[]).find((m) => m.label === "Claude Opus 4.8");
  assert.ok(opus, "Opus 4.8 present in model policy list");

  const toggled = await post("/api/models/toggle", { id: opus.id, blocked: true });
  assert.equal(toggled.status, 200);

  const res = await sendModel("claude-opus-4-8");
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(String(body.error), /blocked/i);
  assert.equal(body.model, "claude-opus-4-8");

  assert.equal(upstream.received.length, before, "blocked request never reached upstream");
  const e = trafficLog.recent(1, false)[0];
  assert.equal(e.status, 403);
  assert.equal(e.blocked, true);
  assert.equal(e.model, "claude-opus-4-8");
});

// --- FAILURE (from client's view): an UNblocked model still passes ------------
test("failure: a non-blocked model is forwarded normally (200)", async () => {
  const st = await (await fetch(`${base}/api/state`)).json();
  const opus = (st.models as any[]).find((m) => m.label === "Claude Opus 4.8");
  await post("/api/models/toggle", { id: opus.id, blocked: true }); // block Opus only

  const res = await sendModel("claude-sonnet-4-6"); // different model
  assert.equal(res.status, 200);
  assert.ok(upstream.last()!.body.length > 0, "request reached upstream");
});

// --- EDGE: every Claude model is a named entry; block them all individually ---
test("edge: all Claude models are listed by name and each blocks its own model", async () => {
  const st = await (await fetch(`${base}/api/state`)).json();
  const claude = (st.models as any[]).filter((m) => m.match.startsWith("claude-"));
  // named Claude family present (no lumped catch-all)
  const labels = claude.map((m) => m.label);
  assert.ok(labels.includes("Claude Opus 4.8"));
  assert.ok(labels.includes("Claude Fable 5"));
  assert.ok(!(st.models as any[]).some((m) => m.match === "claude-"), "no lumped catch-all");

  // block each named Claude model -> its exact model id is 403'd
  for (const m of claude) {
    await post("/api/models/toggle", { id: m.id, blocked: true });
    const res = await sendModel(m.match); // match string IS the model id
    assert.equal(res.status, 403, `${m.label} (${m.match}) blocked`);
  }
  // a non-Claude model is unaffected
  const ok = await post("/openai/v1/chat/completions", { model: "gpt-5.5", messages: [] });
  assert.equal(ok.status, 200);
});

// --- EDGE: toggling an unknown model id -> 404 --------------------------------
test("edge: toggling an unknown model id returns 404", async () => {
  const res = await post("/api/models/toggle", { id: "nope-not-real", blocked: true });
  assert.equal(res.status, 404);
});
