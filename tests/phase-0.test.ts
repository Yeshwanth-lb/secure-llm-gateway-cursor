// ===== PHASE 0 E2E TESTS — skeleton, config, /healthz, body cap, 404 hint =====
// Drives the real gateway over HTTP on an ephemeral port. Zero deps: node:test +
// the built-in global fetch. Hermetic — no real upstream, small body cap injected.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../secure-llm-gateway.ts";

let server: ReturnType<typeof createGatewayServer>;
let base: string;

const BODY_CAP = 1024; // tiny cap so the edge test can exceed it cheaply

before(async () => {
  server = createGatewayServer({ bodyCapBytes: BODY_CAP });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// --- HAPPY: GET /healthz -> 200 -----------------------------------------------
test("happy: GET /healthz returns 200 with ok status", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "ok");
});

// --- FAILURE: unknown path -> 404 JSON hint -----------------------------------
test("failure: unknown path returns 404 JSON routing hint", async () => {
  const res = await fetch(`${base}/definitely-not-a-route`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok(body.error, "404 body carries an error field");
  // hint must actually guide the caller on how to route
  assert.match(JSON.stringify(body).toLowerCase(), /provider|route|anthropic|gemini|openai/);
});

// --- EDGE: body over cap -> 413 -----------------------------------------------
test("edge: request body over cap returns 413", async () => {
  const oversized = "x".repeat(BODY_CAP * 2);
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: oversized,
  });
  assert.equal(res.status, 413);
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok(body.error, "413 body carries an error field");
});
