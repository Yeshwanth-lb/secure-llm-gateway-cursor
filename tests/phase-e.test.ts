// ===== PHASE E — CONTROL-PLANE CONSOLE + /api ================================
// The console webpage (served at /, /console, and GET /mcp for browsers) plus
// the live /api/* control plane: rule toggles, runtime custom rules, and the
// allowlist — all acting on the SAME in-process registry the proxy uses.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createGatewayServer, resetRedactionRules, redactText } from "../secure-llm-gateway.ts";

let server: ReturnType<typeof createGatewayServer>;
let base: string;

before(async () => {
  server = createGatewayServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections?.(); // drop any lingering SSE keep-alive sockets
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});
beforeEach(() => resetRedactionRules()); // each test starts from default rules

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// --- HAPPY: console served at /mcp for a browser (Accept: text/html) ----------
test("happy: GET /mcp with browser Accept serves the console webpage", async () => {
  const res = await fetch(`${base}/mcp`, { headers: { accept: "text/html" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /Gateway Console/);
  assert.match(html, /Allowlist/);
  assert.match(html, /Traffic Inspector/);
});

// MCP client (Accept: text/event-stream) still gets the SSE transport, not HTML.
test("happy: GET /mcp with event-stream Accept opens the MCP SSE transport", async () => {
  const { ct, firstEvent, req } = await new Promise<{
    ct: string;
    firstEvent: string;
    req: http.ClientRequest;
  }>((resolve, reject) => {
    const r = http.get(
      `${base}/mcp`,
      { headers: { accept: "text/event-stream" } },
      (res) => {
        res.once("data", (d: Buffer) =>
          resolve({ ct: String(res.headers["content-type"]), firstEvent: d.toString("utf8"), req: r }),
        );
      },
    );
    r.on("error", reject);
  });
  assert.match(ct, /text\/event-stream/);
  assert.match(firstEvent, /event: endpoint/); // legacy transport handshake, not HTML
  req.destroy(); // close the stream so the server has no lingering socket
});

// --- state + live toggle: disabling EMAIL stops email redaction on the proxy --
test("happy: /api state lists rules; toggling EMAIL off changes live redaction", async () => {
  const st = await (await fetch(`${base}/api/state`)).json();
  const names = (st.rules as { name: string }[]).map((r) => r.name);
  assert.ok(names.includes("EMAIL") && names.includes("CREDIT_CARD"));

  // baseline: EMAIL is redacted
  assert.match(redactText("ping a@b.com", "inbound").text, /\[REDACTED_PII_EMAIL\]/);

  const res = await post("/api/rules/toggle", { name: "EMAIL", enabled: false });
  assert.equal(res.status, 200);
  const after = (await res.json()).rules.find((r: any) => r.name === "EMAIL");
  assert.equal(after.enabled, false);

  // live: with EMAIL disabled, the address passes through untouched
  const out = redactText("ping a@b.com", "inbound");
  assert.equal(out.text, "ping a@b.com");
  assert.equal(out.matched.EMAIL, undefined);
});

// --- add custom rule at runtime; it redacts immediately -----------------------
test("happy: adding a custom rule redacts immediately on the live engine", async () => {
  assert.equal(redactText("id EMP-123456 here", "inbound").matched.EMPLOYEE_ID, undefined);
  const res = await post("/api/rules/add", { name: "EMPLOYEE_ID", pattern: "EMP-\\d{6}", flags: "g" });
  assert.equal(res.status, 200);
  const out = redactText("id EMP-123456 here", "inbound");
  assert.match(out.text, /\[REDACTED_PII_EMPLOYEE_ID\]/);
  assert.equal(out.matched.EMPLOYEE_ID, 1);
});

// --- allowlist exempts a value even though a rule matches ---------------------
test("happy: allowlisted value is not redacted though EMAIL rule matches", async () => {
  assert.match(redactText("reach test@example.com", "inbound").text, /\[REDACTED_PII_EMAIL\]/);
  const res = await post("/api/allowlist/add", { pattern: "test@example\\.com" });
  assert.equal(res.status, 200);
  const out = redactText("reach test@example.com and real@corp.com", "inbound");
  assert.match(out.text, /test@example\.com/);       // allowlisted -> intact
  assert.match(out.text, /\[REDACTED_PII_EMAIL\]/);   // the other email still redacted
  assert.equal(out.matched.EMAIL, 1);
});

// --- FAILURE: bad custom regex -> 400 with a helpful message ------------------
test("failure: adding an invalid regex returns 400 and does not register", async () => {
  const res = await post("/api/rules/add", { name: "BAD", pattern: "(unclosed[" });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.match(String(j.error), /bad regex/i);
  const st = await (await fetch(`${base}/api/state`)).json();
  assert.ok(!(st.rules as any[]).some((r) => r.name === "BAD"));
});

// --- FAILURE: default rules cannot be removed (must disable instead) ----------
test("failure: removing a default rule is rejected", async () => {
  const res = await post("/api/rules/remove", { name: "EMAIL" });
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /default/i);
});

// --- EDGE: toggle of an unknown rule -> 404 -----------------------------------
test("edge: toggling a nonexistent rule returns 404", async () => {
  const res = await post("/api/rules/toggle", { name: "NOPE", enabled: false });
  assert.equal(res.status, 404);
});

// --- REGRESSION: the console's inline script must be valid JS ------------------
// A single mismatched quote once killed every button (whole script failed to
// parse). Compile the served <script> with `new Function` — throws on any
// syntax error without executing it. Guards that class of bug for good.
test("regression: console inline script parses (no syntax error -> buttons work)", async () => {
  const html = await (await fetch(`${base}/mcp`, { headers: { accept: "text/html" } })).text();
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "console has an inline script");
  assert.doesNotThrow(() => new Function(m![1]), "inline script is syntactically valid");
});

// --- FAILURE: admin token required for POST mutations when configured ---------
test("failure: POST mutations require admin token when GATEWAY_ADMIN_TOKEN is set", async () => {
  const admin = createGatewayServer({ adminToken: "test-admin-token" });
  await new Promise<void>((r) => admin.listen(0, "127.0.0.1", r));
  const adminBase = `http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
  try {
    const denied = await fetch(`${adminBase}/api/rules/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "EMAIL", enabled: false }),
    });
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${adminBase}/api/rules/toggle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gateway-token": "test-admin-token",
      },
      body: JSON.stringify({ name: "EMAIL", enabled: false }),
    });
    assert.equal(allowed.status, 200);
  } finally {
    admin.closeAllConnections?.();
    await new Promise<void>((r, j) => admin.close((e) => (e ? j(e) : r())));
    resetRedactionRules();
  }
});
