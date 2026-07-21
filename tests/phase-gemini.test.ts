// ===== GEMINI EXTENSION — STAGE 1 TESTS ====================================
// The Gemini web browser-extension (see scripts/gemini_imp.md) reuses the
// already-shipped Phase L `POST /redact` endpoint UNCHANGED. This stage is
// VERIFICATION, not new construction: it confirms the existing endpoint meets
// the extension's needs (one-way fixed-token substitution, no map), so the
// extension code can be written against a proven contract.
//
// Design ref: scripts/gemini_imp.md §6 Stage 1. Note the deliberate rev.2
// decision — no reversible map, so `/redact`'s existing `{redacted, matched,
// piiDetected}` shape is exactly what the extension consumes.
//
// PII fixtures are built from fragments so no full literal appears in source
// (matches tests/phase-l.test.ts convention; guards the "no raw PII in repo"
// invariant even for test files).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../secure-llm-gateway.ts";

// Runtime-constructed PII (never a full literal in source).
const EMAIL = "alice" + "@" + "corp.com";
const CC = ["4111", "1111", "1111", "1111"].join(""); // Luhn-valid
const PHONE = "+1-" + "202-" + "555-" + "0147"; // PHONE_US needs separators/+1

let server: ReturnType<typeof createGatewayServer>;
let base: string;

before(async () => {
  server = createGatewayServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

/** POST a JSON body to /redact and return {status, json}. */
async function redact(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/redact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// --- HAPPY: one email -> fixed token, matched reflects it --------------------
test("happy: single email is replaced with a fixed one-way token", async () => {
  const { status, json } = await redact({ text: `email ${EMAIL} please` });
  assert.equal(status, 200);
  assert.equal(json.piiDetected, true);
  // One-way fixed token (NOT a numbered/reversible placeholder — rev.2 design).
  assert.match(json.redacted, /\[REDACTED_PII_EMAIL\]/);
  // The raw value must be gone from the redacted text.
  assert.ok(!json.redacted.includes("corp.com"), "raw email must not survive");
  assert.ok(json.matched.EMAIL >= 1, "EMAIL count recorded");
  // No `map` field — the extension must NOT depend on one existing.
  assert.equal(json.map, undefined, "endpoint returns no reversible map (by design)");
});

// --- FAILURE: malformed/missing text -> 200 (matches SHIPPED behavior) -------
// The PRD (§4.3, §6 Stage 1) is explicit: the endpoint is shared with the
// Cursor Phase L path and does NOT 400 on bad input — it treats it as empty and
// returns 200. This test locks that ACTUAL behavior so the extension's
// fail-closed logic lives client-side (it treats "no redaction happened" plus a
// reachable gateway correctly), and so nobody "fixes" the endpoint into a 400
// without consciously reassessing the Cursor impact.
test("failure: malformed / missing text returns 200 empty, never crashes or leaks", async () => {
  // Missing `text` field entirely.
  const missing = await redact({ notText: 123 });
  assert.equal(missing.status, 200, "missing text -> 200, treated as empty");
  assert.equal(missing.json.piiDetected, false);
  assert.equal(missing.json.redacted, "");

  // Non-JSON body.
  const nonJson = await redact("this is not json {{{");
  assert.equal(nonJson.status, 200, "non-JSON body -> 200, treated as empty");
  assert.equal(nonJson.json.piiDetected, false);

  // Empty object.
  const empty = await redact({});
  assert.equal(empty.status, 200);
  assert.equal(empty.json.piiDetected, false);
});

// --- EDGE: multiple PII types at once + a no-PII no-op -----------------------
test("edge: multiple PII types all replaced; clean text passes through untouched", async () => {
  // Several distinct types in one prompt.
  const multi = await redact({ text: `mail ${EMAIL}, card ${CC}, call ${PHONE}` });
  assert.equal(multi.status, 200);
  assert.equal(multi.json.piiDetected, true);
  assert.match(multi.json.redacted, /\[REDACTED_PII_EMAIL\]/);
  assert.match(multi.json.redacted, /\[REDACTED_PII_CREDIT_CARD\]/);
  assert.match(multi.json.redacted, /\[REDACTED_PII_PHONE/); // PHONE_US / PHONE_IN family
  // Every raw fragment gone.
  assert.ok(
    !multi.json.redacted.includes("corp.com") &&
      !multi.json.redacted.includes(CC) &&
      !multi.json.redacted.includes("555-0147"),
    "no raw PII fragment survives in redacted text",
  );

  // No PII -> returned unchanged, piiDetected false (no spurious rewriting).
  const clean = await redact({ text: "refactor the add() function and write a test" });
  assert.equal(clean.status, 200);
  assert.equal(clean.json.piiDetected, false);
  assert.equal(clean.json.redacted, "refactor the add() function and write a test");
  assert.deepEqual(clean.json.matched, {});
});

// --- /log-turn: one rich Gemini turn entry (provider+model+clean, redacted) --
test("log-turn: stores one gemini entry with redacted prompt+response and a clean view", async () => {
  const promptRaw = `email me at ${EMAIL}`;
  const responseRaw = `Sure — I noted ${EMAIL} but I can't send mail.`;
  const res = await fetch(`${base}/log-turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: promptRaw, response: responseRaw, model: "gemini-flash", source: "gemini-web-extension" }),
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.logged, true);
  assert.equal(j.piiDetected, true);

  // The entry must appear in the clean-view log, labeled gemini + model, with
  // the raw email gone from BOTH the snapshot and the clean fields.
  const logs = (await (await fetch(`${base}/logs?clean=1`)).json()) as {
    entries: {
      provider: string; model?: string; method: string; path: string;
      payloadSnapshot: { request: string; response: string };
      clean?: { userPrompt: string; assistantOutput: string };
    }[];
  };
  const turn = logs.entries.find((e) => e.method === "CHAT" && e.path === "gemini-web-extension");
  assert.ok(turn, "a CHAT turn entry must be logged");
  assert.equal(turn.provider, "gemini");
  assert.equal(turn.model, "gemini-flash");
  // Clean view shows the distilled prompt/output, both redacted.
  assert.match(turn.clean!.userPrompt, /\[REDACTED_PII_EMAIL\]/);
  assert.match(turn.clean!.assistantOutput, /\[REDACTED_PII_EMAIL\]/);
  // The invariant: no raw email anywhere in the stored entry.
  assert.ok(!JSON.stringify(turn).includes("corp.com"), "no raw PII persisted in the turn entry");
});

// --- /log-turn: no-PII turn still logs, piiDetected false --------------------
test("log-turn: a clean turn is still logged (piiDetected false), no spurious tokens", async () => {
  const res = await fetch(`${base}/log-turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "write a haiku about tests", response: "green bars align / ...", model: "gemini-pro" }),
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.logged, true);
  assert.equal(j.piiDetected, false);
});
