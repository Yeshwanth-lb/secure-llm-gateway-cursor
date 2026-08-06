// ===== ADMIN DASHBOARD — headless tests (Phase U) ===========================
// Drives the real gateway (createGatewayServer) on an ephemeral port with a
// throwaway SQLite file, exactly like the other phase e2e tests. Covers the
// three control-plane areas with a happy / failure / edge trio each:
//   1. Auth       — login + JWT gating + rate-limit + tampered/expired token.
//   2. Events     — /internal/events -> analytics, malformed body is harmless,
//                   and the store NEVER persists a raw PII value.
//   3. Controls   — surface mode PUT -> /internal/config + audit row, Cursor
//                   cannot be set to "redact", audit log is append-only.
//
// PII fixtures are assembled from fragments so no full literal appears in source.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGatewayServer,
  openAdminStore,
  hashPassword,
  signJWT,
  verifyJWT,
  resetLoginRate,
  securityLog,
} from "../secure-llm-gateway.ts";

const PW = "s3cret-" + "password";
const RAW_EMAIL = "dana" + "@" + "corp.example";

let server: ReturnType<typeof createGatewayServer>;
let base: string;
let dir: string;
let dbPath: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gw-admin-"));
  dbPath = join(dir, "admin.db");
  // Seed the first admin before the server starts (same store the gateway opens).
  const store = openAdminStore(dbPath);
  store.createUser("admin", hashPassword(PW));
  server = createGatewayServer({ adminEnabled: true, adminDbPath: dbPath, adminToken: "" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  rmSync(dir, { recursive: true, force: true });
});

const J = (p: string, opts: any = {}) =>
  fetch(base + p, {
    ...opts,
    headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

async function login(username = "admin", password = PW): Promise<string> {
  const r = await J("/admin/api/login", { method: "POST", body: { username, password } });
  const j = await r.json();
  return j.token;
}
const auth = (t: string) => ({ Authorization: "Bearer " + t });

// --- 1. AUTH ----------------------------------------------------------------
test("happy: a seeded admin logs in and the JWT opens a protected route", async () => {
  resetLoginRate();
  const r = await J("/admin/api/login", { method: "POST", body: { username: "admin", password: PW } });
  assert.equal(r.status, 200);
  const { token } = await r.json();
  assert.ok(token, "a token is returned");

  // No token -> 401; valid token -> 200.
  assert.equal((await J("/admin/api/analytics")).status, 401);
  assert.equal((await J("/admin/api/analytics", { headers: auth(token) })).status, 200);
});

test("failure: wrong password is 401 and a 6th attempt in a minute is rate-limited", async () => {
  resetLoginRate();
  for (let i = 0; i < 5; i++) {
    const r = await J("/admin/api/login", { method: "POST", body: { username: "admin", password: "nope" } });
    assert.equal(r.status, 401, `attempt ${i + 1} should be 401`);
  }
  const sixth = await J("/admin/api/login", { method: "POST", body: { username: "admin", password: PW } });
  assert.equal(sixth.status, 429, "the 6th attempt within the window is rate-limited, even with the right password");
});

test("edge: a tampered token and an expired token are both rejected", async () => {
  resetLoginRate();
  const token = await login();
  const tampered = token.slice(0, -2) + (token.endsWith("a") ? "b" : "a");
  assert.equal((await J("/admin/api/analytics", { headers: auth(tampered) })).status, 401);
  assert.equal((await J("/admin/api/analytics", { headers: auth("garbage.token.here") })).status, 401);
  // Expiry is enforced by verifyJWT independent of the server secret.
  assert.equal(verifyJWT(signJWT({ sub: "x" }, "sec", -10), "sec"), null, "an expired token verifies as null");
  assert.ok(verifyJWT(signJWT({ sub: "x" }, "sec", 100), "sec"), "a fresh token verifies");
});

// --- 2. EVENTS / ANALYTICS --------------------------------------------------
test("happy: an internal event is reflected in analytics", async () => {
  resetLoginRate();
  const token = await login();
  const post = await J("/internal/events", {
    method: "POST",
    body: { surface: "chatgpt", decision: "redacted", pii_types: ["EMAIL", "SSN"], latency_ms: 9 },
  });
  assert.equal(post.status, 202, "internal events are fire-and-forget (202)");

  const a = await (await J("/admin/api/analytics?range=30d", { headers: auth(token) })).json();
  assert.ok(a.analytics.cards.total >= 1);
  assert.ok(a.analytics.piiBreakdown.some((p: any) => p.type === "EMAIL"));
  assert.ok(a.analytics.perSurface.some((s: any) => s.surface === "chatgpt"));
});

test("failure: a malformed internal event does not 500 and never blocks", async () => {
  const bad = await fetch(base + "/internal/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ this is not json",
  });
  assert.equal(bad.status, 202, "a malformed body is swallowed, still 202 — a caller is never blocked");
  // Missing required fields also must not throw.
  assert.equal((await J("/internal/events", { method: "POST", body: {} })).status, 202);
});

test("edge: the store never persists a raw PII value, only type names", async () => {
  resetLoginRate();
  const token = await login();
  // A hostile caller tries to sneak a raw value into pii_types alongside a type.
  await J("/internal/events", {
    method: "POST",
    body: { surface: "grok", decision: "redacted", pii_types: ["EMAIL", RAW_EMAIL, "user@" + "x.io"] },
  });
  const csv = await (await J("/admin/api/events?range=30d&format=csv", { headers: auth(token) })).text();
  assert.ok(csv.includes("EMAIL"), "the type name is kept");
  assert.ok(!csv.includes(RAW_EMAIL), "the raw email must not be stored");
  assert.ok(!csv.includes("@"), "no raw value shaped like an address survives sanitisation");
});

// --- 3. CONTROLS / AUDIT ----------------------------------------------------
test("happy: a surface mode change reflects in /internal/config and writes an audit row", async () => {
  resetLoginRate();
  const token = await login();
  const put = await J("/admin/api/surfaces/chatgpt", { method: "PUT", headers: auth(token), body: { mode: "block" } });
  assert.equal(put.status, 200);

  const cfg = await (await J("/internal/config/chatgpt")).json();
  assert.equal(cfg.mode, "block", "the enforcement point would read the new mode");

  const audit = await (await J("/admin/api/audit", { headers: auth(token) })).json();
  assert.ok(
    audit.audit.some((a: any) => a.action === "surface_config.update" && a.target === "chatgpt"),
    "the change is audited",
  );
});

test("failure: Cursor cannot be set to a mode it can't do (redact -> 400)", async () => {
  resetLoginRate();
  const token = await login();
  const r = await J("/admin/api/surfaces/cursor", { method: "PUT", headers: auth(token), body: { mode: "redact" } });
  assert.equal(r.status, 400, "Cursor hooks can only block/allow, never redact");
  const body = await r.json();
  assert.match(body.error, /not valid for cursor/i);
});

test("edge: the audit log is append-only and a disabled surface reports correctly", async () => {
  resetLoginRate();
  const token = await login();
  // No mutation verb is exposed for the audit log.
  assert.equal((await J("/admin/api/audit", { method: "DELETE", headers: auth(token) })).status, 404);

  // Disabling a surface is reflected for its enforcement point.
  await J("/admin/api/surfaces/deepseek", { method: "PUT", headers: auth(token), body: { enabled: false } });
  const cfg = await (await J("/internal/config/deepseek")).json();
  assert.equal(cfg.enabled, false);
});

// --- 4. MIRRORED CONSOLE TABS (rules/allowlist/models/traffic/try) ----------
test("happy: the mirrored console endpoints are JWT-gated and reuse the live engine", async () => {
  resetLoginRate();
  const token = await login();

  // Console state (rules + allowlist + models) — the same shape the console renders.
  const st = await (await J("/admin/api/console", { headers: auth(token) })).json();
  assert.ok(Array.isArray(st.rules) && st.rules.length > 0, "rules present");
  assert.ok(Array.isArray(st.models) && st.models.length > 0, "model policies present");

  // A rule toggle flows through to the live redaction engine.
  const tog = await J("/admin/api/console/rules/toggle", { method: "POST", headers: auth(token), body: { name: "EMAIL", enabled: false } });
  assert.equal(tog.status, 200);
  const after = await (await J("/admin/api/console", { headers: auth(token) })).json();
  assert.equal(after.rules.find((r: any) => r.name === "EMAIL").enabled, false);
  // restore
  await J("/admin/api/console/rules/toggle", { method: "POST", headers: auth(token), body: { name: "EMAIL", enabled: true } });

  // Try-redaction is a preview that stores nothing.
  const t = await (await J("/admin/api/try", { method: "POST", headers: auth(token), body: { text: `write ${RAW_EMAIL}` } })).json();
  assert.match(t.redacted, /\[REDACTED_PII_EMAIL\]/);
  assert.ok(t.matched.EMAIL >= 1);

  // Traffic inspector returns the ring buffer (post-redaction).
  const logs = await (await J("/admin/api/logs?clean=1", { headers: auth(token) })).json();
  assert.ok(Array.isArray(logs.entries));
});

test("failure: the mirrored console + traffic endpoints reject an unauthenticated caller", async () => {
  assert.equal((await J("/admin/api/console")).status, 401);
  assert.equal((await J("/admin/api/logs")).status, 401);
  assert.equal((await J("/admin/api/try", { method: "POST", body: { text: "x" } })).status, 401);
  assert.equal((await J("/admin/api/console/rules/toggle", { method: "POST", body: { name: "EMAIL", enabled: false } })).status, 401);
});

test("edge: /internal/config carries the mode an extension enforces (block/off/redact)", async () => {
  resetLoginRate();
  const token = await login();
  // The extension reads mode from here: block -> stop all sends on the site.
  await J("/admin/api/surfaces/grok", { method: "PUT", headers: auth(token), body: { mode: "block" } });
  const blocked = await (await J("/internal/config/grok")).json();
  assert.equal(blocked.mode, "block");
  assert.equal(blocked.enabled, true, "mode block is distinct from the enabled kill-switch");
  // off -> redaction disabled for that surface (raw allowed); redact -> normal.
  await J("/admin/api/surfaces/grok", { method: "PUT", headers: auth(token), body: { mode: "off" } });
  assert.equal((await (await J("/internal/config/grok")).json()).mode, "off");
});

// --- 4. PROMPT GUARD (Checkpoint 1) ----------------------------------------
test("prompt-guard: JWT-gated tab data returns prompt + guidance + model output", async () => {
  resetLoginRate();
  securityLog.clear();
  securityLog.push({
    id: "pg-test-1",
    timestamp: new Date().toISOString(),
    surface: "claude-code",
    verdict: "inject",
    categories: ["sql_injection"],
    confidence: 0.9,
    tier: 2,
    rawPrompt: "build a SQL query for " + RAW_EMAIL,
    guidance: "[SECURITY & SAFETY GUIDANCE] Use parameterized queries.",
    response: "Here is a parameterized query using ? placeholders.",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
  });
  // gated: no token -> 401.
  assert.equal((await J("/admin/api/prompt-guard")).status, 401);
  const token = await login();
  const r = await J("/admin/api/prompt-guard", { headers: auth(token) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.entries.length, 1);
  assert.equal(j.entries[0].verdict, "inject");
  assert.match(j.entries[0].guidance, /parameterized/i);
  assert.match(j.entries[0].response, /parameterized query/i, "model output is exposed to the dashboard");
  assert.equal(j.summary.injected, 1);
  assert.equal(j.summary.byCategory.sql_injection, 1);
});
