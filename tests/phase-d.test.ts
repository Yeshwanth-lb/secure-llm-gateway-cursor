// ===== PHASE D — TRAFFIC INSPECTOR (frontend) =================================
// A zero-dep, self-contained HTML dashboard served by the gateway that polls
// /logs. Happy: GET / -> 200 text/html with the app shell. Failure: POST / is
// not the inspector (falls through to routing). Edge: the page references the
// live /logs endpoint it polls.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../secure-llm-gateway.ts";

let server: ReturnType<typeof createGatewayServer>;
let base: string;

before(async () => {
  server = createGatewayServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

// --- HAPPY: GET / serves the inspector HTML -----------------------------------
test("happy: GET / returns 200 text/html traffic-inspector shell", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /Traffic Inspector/);
});

// --- HAPPY: /inspector is an alias --------------------------------------------
test("happy: GET /inspector serves the same shell", async () => {
  const res = await fetch(`${base}/inspector`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
});

// --- FAILURE: POST / is not the inspector (still routes/404s) ------------------
test("failure: POST / does not serve HTML (falls through to routing)", async () => {
  const res = await fetch(`${base}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.notEqual(res.status, 200);
  assert.doesNotMatch(res.headers.get("content-type") ?? "", /text\/html/);
});

// --- EDGE: the page polls the live /logs endpoint -----------------------------
test("edge: inspector page references the /logs endpoint it polls", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /\/logs/);
  // and it must not leak any inline secret/PII of its own — it renders from /logs
  assert.doesNotMatch(html, /sk-ant-/);
});
