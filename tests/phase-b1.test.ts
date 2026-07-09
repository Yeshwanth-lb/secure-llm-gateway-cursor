// ===== PHASE B1 TESTS — routing (5-tier) + header forwarding =================
// Exercises resolveRoute / buildForwardHeaders through their real interfaces.
// resolveRoute only reads req.url + req.headers, so a minimal shim suffices.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { resolveRoute } from "../src/routing.ts";
import { buildForwardHeaders } from "../src/routing.ts";

const UPSTREAMS = {
  anthropic: "https://anthropic.test",
  gemini: "https://gemini.test",
  openai: "https://openai.test",
};

function fakeReq(
  url: string,
  headers: Record<string, string> = {},
  method = "POST",
): IncomingMessage {
  return { url, headers, method } as unknown as IncomingMessage;
}

// --- HAPPY: path-prefix route resolves to the right upstream + strips prefix ---
test("happy: /openai/... prefix routes to openai and strips the prefix", () => {
  const r = resolveRoute(fakeReq("/openai/v1/chat/completions"), UPSTREAMS);
  assert.ok(r, "a route is resolved");
  assert.equal(r!.provider, "openai");
  assert.equal(r!.upstreamBase, "https://openai.test");
  assert.equal(r!.forwardPath, "/v1/chat/completions");
});

// --- FAILURE: no routable signal at all -> null (server turns this into 404) ---
test("failure: an unroutable request resolves to null", () => {
  const r = resolveRoute(fakeReq("/v1/models", {}), UPSTREAMS); // ambiguous, no headers
  assert.equal(r, null);
});

// --- EDGE: ambiguous /v1/models disambiguated by header sniff (x-api-key) ------
test("edge: ambiguous /v1/models with x-api-key sniffs to anthropic", () => {
  const r = resolveRoute(
    fakeReq("/v1/models", { "x-api-key": "secret-key-value" }),
    UPSTREAMS,
  );
  assert.ok(r, "header sniff yields a route");
  assert.equal(r!.provider, "anthropic");
  assert.equal(r!.forwardPath, "/v1/models"); // no prefix to strip
});

// --- extra: tier precedence + heuristics + upstream override ------------------
test("extra: header tier beats heuristic; gemini heuristic; x-llm-upstream override", () => {
  // x-llm-provider header (tier 2) wins over the openai-looking path (tier 3)
  const forced = resolveRoute(
    fakeReq("/v1/chat/completions", { "x-llm-provider": "anthropic" }),
    UPSTREAMS,
  );
  assert.equal(forced!.provider, "anthropic");

  // gemini path heuristic
  const gem = resolveRoute(fakeReq("/v1beta/models/gemini:generateContent"), UPSTREAMS);
  assert.equal(gem!.provider, "gemini");

  // per-request upstream override wins over configured base
  const ovr = resolveRoute(
    fakeReq("/openai/v1/chat/completions", { "x-llm-upstream": "http://127.0.0.1:9101" }),
    UPSTREAMS,
  );
  assert.equal(ovr!.upstreamBase, "http://127.0.0.1:9101");
});

// --- extra: header forwarding strips hop-by-hop, forces identity, keeps auth ---
test("extra: buildForwardHeaders drops hop-by-hop, forces identity, preserves auth", () => {
  const req = fakeReq("/openai/v1/chat/completions", {
    host: "localhost:8000",
    connection: "keep-alive",
    "accept-encoding": "gzip, br",
    "content-length": "123",
    authorization: "Bearer sk-should-survive",
    "x-llm-provider": "openai",
    "x-llm-upstream": "http://x",
    "content-type": "application/json",
  });
  const route = resolveRoute(req, UPSTREAMS)!;
  const h = buildForwardHeaders(req, route);

  assert.equal(h.host, undefined, "host is hop-by-hop, dropped");
  assert.equal(h.connection, undefined, "connection dropped");
  assert.equal(h["content-length"], undefined, "content-length recomputed downstream");
  assert.equal(h["accept-encoding"], "identity", "identity forced so body is inspectable");
  assert.equal(h.authorization, "Bearer sk-should-survive", "auth passes through intact");
  assert.equal(h["x-llm-provider"], undefined, "gateway control header not forwarded");
  assert.equal(h["x-llm-upstream"], undefined, "gateway control header not forwarded");
  assert.equal(h["content-type"], "application/json", "content-type preserved");
});
