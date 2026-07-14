// ===== PHASE L TESTS — Cursor tool-data SCRUB hook =========================
// Cursor's preToolUse/postToolUse hooks CAN rewrite content, so this hook scrubs
// PII out of tool inputs/outputs via the gateway's POST /redact:
//   - preToolUse  -> { permission:"allow", updated_input: <scrubbed> }
//   - postToolUse -> { updated_mcp_tool_output: <scrubbed> }
// Fail-closed: gateway error -> preToolUse DENIES, postToolUse WITHHOLDS (never
// passes raw). Tests spawn the REAL hook against a REAL gateway (async spawn, not
// spawnSync — spawnSync would deadlock the in-process gateway serving /redact).
// PII fixtures are built from fragments so no full literal appears in source.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../secure-llm-gateway.ts";

const HOOK = fileURLToPath(new URL("../scripts/cursor-tool-redact-hook.mjs", import.meta.url));

// Runtime-constructed PII (never a full literal in source).
const EMAIL = "jane.doe" + "@" + "example.org";
const SSN = ["078", "05", "1120"].join("-");
const CC = ["4111", "1111", "1111", "1111"].join(""); // Luhn-valid

let server: ReturnType<typeof createGatewayServer>;
let port: number;
let tmpDir: string;

before(async () => {
  server = createGatewayServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-l-"));
});

after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Run the hook with stdin, pointed at a gateway port (default: live test one). */
function runHook(
  input: string,
  portOverride?: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: String(portOverride ?? port),
        GATEWAY_ENV_BOOTSTRAPPED: "1",
        GATEWAY_STATE_DIR: tmpDir,
      },
    });
    let stdout = "";
    let stderr = "";
    cp.stdout.on("data", (d) => (stdout += d));
    cp.stderr.on("data", (d) => (stderr += d));
    cp.on("close", (code) => resolve({ status: code, stdout, stderr }));
    cp.stdin.write(input);
    cp.stdin.end();
  });
}

// --- HAPPY: postToolUse scrubs an MCP tool output containing PII --------------
test("happy: postToolUse rewrites MCP tool output, replacing PII with tokens", async () => {
  const out = await runHook(
    JSON.stringify({
      hook_event_name: "postToolUse",
      tool_name: "read_db_row",
      tool_output: `row: email=${EMAIL}, ssn=${SSN}`,
    }),
  );
  assert.equal(out.status, 0);
  const j = JSON.parse(out.stdout);
  assert.ok("updated_mcp_tool_output" in j, "must return a rewritten output");
  const scrubbed = String(j.updated_mcp_tool_output);
  assert.match(scrubbed, /\[REDACTED_PII_EMAIL\]/);
  assert.match(scrubbed, /\[REDACTED_PII_SSN\]/);
  // The raw PII must not survive anywhere in the emitted payload.
  assert.ok(!out.stdout.includes("example.org"), "raw email must not appear");
  assert.ok(!out.stdout.includes(SSN), "raw ssn must not appear");
});

// --- FAILURE: gateway unreachable -> fail closed (deny / withhold, never raw) --
test("failure: gateway down -> preToolUse denies, postToolUse withholds (no raw leak)", async () => {
  const deadPort = port + 1; // nothing listening here
  const raw = `card ${CC} for ${EMAIL}`;

  const pre = await runHook(
    JSON.stringify({ hook_event_name: "preToolUse", tool_name: "http_post", tool_input: { body: raw } }),
    deadPort,
  );
  const preJson = JSON.parse(pre.stdout);
  assert.equal(preJson.permission, "deny", "preToolUse must deny when it cannot scrub");
  assert.notEqual(pre.status, 0, "deny also signals via non-zero exit");
  assert.ok(!pre.stdout.includes(CC) && !pre.stdout.includes("example.org"), "no raw PII on deny");

  const post = await runHook(
    JSON.stringify({ hook_event_name: "postToolUse", tool_name: "http_post", tool_output: raw }),
    deadPort,
  );
  const postJson = JSON.parse(post.stdout);
  assert.match(String(postJson.updated_mcp_tool_output), /withheld/i, "output withheld on failure");
  assert.ok(!post.stdout.includes(CC) && !post.stdout.includes("example.org"), "no raw PII on withhold");
});

// --- EDGE: nested/structured input scrubbed; clean payload passes untouched ---
test("edge: preToolUse scrubs nested structured input; no-PII input left untouched", async () => {
  // Nested object: only string leaves with PII change; other fields preserved.
  const dirty = await runHook(
    JSON.stringify({
      hook_event_name: "preToolUse",
      tool_name: "create_ticket",
      tool_input: { title: "bug", meta: { reporter: EMAIL, priority: 3 }, tags: [`cc:${CC}`] },
    }),
  );
  assert.equal(dirty.status, 0);
  const dj = JSON.parse(dirty.stdout);
  assert.equal(dj.permission, "allow");
  assert.ok(dj.updated_input, "PII input must be rewritten");
  assert.equal(dj.updated_input.meta.reporter, "[REDACTED_PII_EMAIL]");
  assert.equal(dj.updated_input.meta.priority, 3, "non-PII fields preserved");
  assert.equal(dj.updated_input.title, "bug");
  assert.match(String(dj.updated_input.tags[0]), /\[REDACTED_PII_CREDIT_CARD\]/);
  assert.ok(!dirty.stdout.includes("example.org") && !dirty.stdout.includes(CC), "no raw PII");

  // Clean input: no rewrite, plain allow (don't touch payloads that don't need it).
  const clean = await runHook(
    JSON.stringify({
      hook_event_name: "preToolUse",
      tool_name: "create_ticket",
      tool_input: { title: "refactor add()", priority: 1 },
    }),
  );
  const cj = JSON.parse(clean.stdout);
  assert.equal(cj.permission, "allow");
  assert.equal(cj.updated_input, undefined, "no rewrite when there's no PII");
  assert.equal(clean.status, 0);
});

// --- AUDIT: a scrub records a COUNTS-ONLY log entry (no raw text) --------------
test("audit: tool-data scrub logs a counts-only entry with an empty snapshot", async () => {
  const base = `http://127.0.0.1:${port}`;
  await runHook(
    JSON.stringify({
      hook_event_name: "postToolUse",
      tool_name: "MCP:read_customer",
      tool_output: `email ${EMAIL}`,
    }),
  );
  const logs = (await (await fetch(`${base}/logs`)).json()) as {
    entries: {
      method: string; path: string; piiDetected: boolean;
      payloadSnapshot: { request: string; response: string };
      matchedRules: { inbound: Record<string, number> };
    }[];
  };
  const hookEntry = logs.entries.find((e) => e.method === "HOOK");
  assert.ok(hookEntry, "a HOOK audit entry must be recorded");
  assert.match(hookEntry.path, /^cursor:postToolUse/, "source labels the event + tool");
  assert.equal(hookEntry.piiDetected, true);
  assert.ok(hookEntry.matchedRules.inbound.EMAIL >= 1, "EMAIL count recorded");
  // The invariant: NO raw text stored anywhere in the entry.
  assert.equal(hookEntry.payloadSnapshot.request, "", "no request text persisted");
  assert.equal(hookEntry.payloadSnapshot.response, "", "no response text persisted");
  assert.ok(!JSON.stringify(hookEntry).includes("example.org"), "no raw PII in the log entry");
});
