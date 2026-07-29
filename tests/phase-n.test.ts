// ===== PHASE N TESTS — queue-bypass leak audit ==============================
// Live finding 2026-07-27 (Cursor 2.1.207): `beforeSubmitPrompt` is NOT invoked
// when a message is QUEUED while the agent is busy. The capture log proves it —
// a queued `my email is <addr>` was delivered to the model with no hook call at
// all, neither allow nor deny. There is no interception point on the drain path
// (no other Cursor hook carries prompt text), so this bypass CANNOT be blocked.
//
// What we can do is make it visible instead of silent. The prompt hook records a
// HASH of every prompt it approves; the stop hook compares each delivered user
// message against that set and flags a turn whose message never passed the gate.
// A row that is both `unchecked` and `piiDetected` is a real leak, logged.
//
// Both hooks are spawned for real against a real gateway. PII fixtures are built
// from fragments at runtime so no full literal appears in source.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../secure-llm-gateway.ts";

const PROMPT_HOOK = fileURLToPath(new URL("../scripts/cursor-redact-hook.mjs", import.meta.url));
const TURN_HOOK = fileURLToPath(new URL("../scripts/cursor-turn-log-hook.mjs", import.meta.url));

const EMAIL = "queued.user" + "@" + "example.com";

let server: ReturnType<typeof createGatewayServer>;
let port: number;
let tmpDir: string;

before(async () => {
  server = createGatewayServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-n-"));
});

after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Async spawn (never spawnSync): the in-process gateway needs a free event loop
 *  to answer /detect and /log-turn while the hook is running. */
function runHook(hook: string, input: string, stateDir: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const cp = spawn(process.execPath, [hook], {
      env: {
        ...process.env,
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: String(port),
        GATEWAY_ENV_BOOTSTRAPPED: "1",
        GATEWAY_STATE_DIR: stateDir,
        GATEWAY_NO_DESKTOP_NOTIFY: "1", // no GUI popups during tests
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

/** Send a prompt through the REAL block/allow hook — the only way a prompt gets
 *  recorded as approved. No transcript_path: this is the composer path. */
async function approve(text: string, stateDir: string) {
  const r = await runHook(
    PROMPT_HOOK,
    JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: text }),
    stateDir,
  );
  assert.equal(r.status, 0, `a clean prompt must be allowed: ${r.stderr}`);
  return r;
}

/** One transcript user entry, wrapped in Cursor's context envelope. */
function userLine(text: string) {
  return JSON.stringify({
    role: "user",
    message: {
      content: [{ type: "text", text: `<timestamp>Mon Jul 27 2026</timestamp>\n<user_query>\n${text}\n</user_query>` }],
    },
  });
}
function assistantLine(text: string) {
  return JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } });
}
const TURN_END = JSON.stringify({ type: "turn_ended", status: "success" });

function makeCase(name: string, lines: string[]) {
  const dir = fs.mkdtempSync(path.join(tmpDir, name + "-"));
  const transcript = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(transcript, lines.join("\n") + "\n");
  return { dir, transcript };
}

async function logTurn(transcript: string, stateDir: string) {
  const r = await runHook(
    TURN_HOOK,
    JSON.stringify({ hook_event_name: "stop", transcript_path: transcript, model: "claude-opus-5" }),
    stateDir,
  );
  assert.equal(r.status, 0, "logging must never fail the session");
  return r;
}

async function cursorEntries() {
  const res = await fetch(`http://127.0.0.1:${port}/logs?clean=1`);
  const body = (await res.json()) as { entries: any[] };
  return body.entries.filter((e) => e.path === "cursor-agent");
}

/** The entry whose clean prompt contains `needle` (rows accumulate across tests). */
async function entryMatching(needle: string) {
  const found = (await cursorEntries()).filter((e) =>
    String(e.clean?.userPrompt ?? "").includes(needle),
  );
  assert.equal(found.length, 1, `exactly one row for "${needle}"`);
  return found[0];
}

// --- HAPPY: a message the hook approved logs as a normal, non-flagged turn -----
test("happy: an approved prompt logs a CHAT row that is not flagged unchecked", async () => {
  const text = "explain the routing table please";
  const { dir, transcript } = makeCase("approved", [
    userLine(text),
    assistantLine("Here is the routing table."),
    TURN_END,
  ]);

  await approve(text, dir); // went through the composer -> gate saw it
  await logTurn(transcript, dir);

  const e = await entryMatching("routing table please");
  assert.equal(e.method, "CHAT");
  assert.notEqual(e.unchecked, true, "a gated prompt must NOT be flagged as bypassing the gate");
});

// --- FAILURE: the queue bypass — PII delivered with no hook call, flagged ------
test("failure: a queued PII message never seen by the gate is logged as unchecked", async () => {
  // The dir has SOME approval history (a real session always does), so a missing
  // hash means "this one bypassed the gate", not "we have no data".
  const { dir, transcript } = makeCase("queued", [
    userLine(`send it to ${EMAIL} tomorrow`),
    assistantLine("Understood."),
    TURN_END,
  ]);
  await approve("an earlier composer prompt", dir);

  await logTurn(transcript, dir);

  const e = await entryMatching("tomorrow");
  assert.equal(e.unchecked, true, "a message the gate never saw must be flagged");
  assert.equal(e.piiDetected, true, "unchecked + PII is the leak signature");
  // Flagging a leak must not itself become a leak.
  assert.ok(!JSON.stringify(e).includes(EMAIL), "no raw PII stored in the leak row");
  assert.match(e.clean.userPrompt, /REDACTED_PII_EMAIL/);
});

// --- EDGE: no approval history -> no flag; a mixed turn IS flagged -------------
test("edge: absent approval history flags nothing, a partly-queued turn is flagged", async () => {
  // First install / cleared state: we cannot distinguish bypass from "no data",
  // so nothing is flagged. Flagging every historical turn would cry wolf.
  const fresh = makeCase("nohistory", [
    userLine(`old message with ${EMAIL} inside`),
    assistantLine("ok"),
    TURN_END,
  ]);
  await logTurn(fresh.transcript, fresh.dir);
  const cold = await entryMatching("inside");
  assert.notEqual(cold.unchecked, true, "no approval history must not manufacture leaks");
  assert.ok(!JSON.stringify(cold).includes(EMAIL), "still redacted, flag or not");

  // A turn can hold several messages: one typed in the composer, one queued
  // behind it. If ANY of them bypassed the gate the turn is flagged.
  const typed = "the composer message about caching";
  const mixed = makeCase("mixed", [
    userLine(typed),
    userLine("a queued follow-up that skipped the gate"),
    assistantLine("Answering both."),
    TURN_END,
  ]);
  await approve(typed, mixed.dir);
  await logTurn(mixed.transcript, mixed.dir);

  const e = await entryMatching("caching");
  assert.equal(e.unchecked, true, "one unapproved message in the turn flags the turn");
  assert.match(e.clean.userPrompt, /queued follow-up/, "both messages are in the row");
});
