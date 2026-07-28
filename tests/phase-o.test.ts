// ===== PHASE O TESTS — Cursor attached-file leak audit ======================
// A file the user has OPEN or SELECTED (no `@`-mention) is auto-attached by Cursor
// into the request as an <attached_files> block. That block never appears in the
// beforeSubmitPrompt hook payload (proved live 2026-07-28: ctx only carried the
// typed text + rule refs), so it CANNOT be blocked — the same wall as a queued
// send. Worse, the turn-log hook stripped <attached_files> before logging, so the
// leak was also INVISIBLE (the console row read "no PII").
//
// This phase closes the VISIBILITY half: the turn-log hook sends the attached-file
// content as `scanExtra`, and /log-turn folds its PII into the row's counts and
// marks the row `unchecked` (attachment content was never gated) — WITHOUT storing
// or displaying the file dump. Blocking stays impossible; the audit no longer lies.
//
// Tests spawn the REAL hook against a REAL gateway. PII fixtures are assembled from
// fragments at runtime so no full literal appears in source.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../secure-llm-gateway.ts";

const HOOK = fileURLToPath(new URL("../scripts/cursor-turn-log-hook.mjs", import.meta.url));
const APPROVED_FILE = "cursor-approved-prompts.json";

const EMAIL = "leak.victim" + "@" + "example.com";
const CARD = "4111" + " 1111 " + "1111 1111"; // Luhn-valid test card
const USER_EMAIL = "cursor.account" + "@" + "example.com"; // Cursor stamps this on every turn

/** Same digest the hooks use to hash an approved prompt. */
function promptHash(text: string) {
  return createHash("sha256").update(String(text).trim(), "utf8").digest("hex").slice(0, 32);
}

let server: ReturnType<typeof createGatewayServer>;
let port: number;
let tmpDir: string;

before(async () => {
  server = createGatewayServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-o-"));
});

after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runHook(input: string, opts: { port?: number; stateDir?: string } = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const cp = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: String(opts.port ?? port),
        GATEWAY_ENV_BOOTSTRAPPED: "1",
        GATEWAY_STATE_DIR: opts.stateDir ?? tmpDir,
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

function userLine(text: string) {
  return JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } });
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

async function cursorEntries() {
  const res = await fetch(`http://127.0.0.1:${port}/logs?clean=1`);
  const body = (await res.json()) as { entries: any[] };
  return body.entries.filter((e) => e.path === "cursor-agent");
}

/** The cursor row whose displayed prompt contains `marker`. Selecting by content
 *  is order-independent (the log is newest-first and shared across tests). */
async function cursorEntryWith(marker: string) {
  const hit = (await cursorEntries()).filter((e) => String(e.clean?.userPrompt ?? "").includes(marker));
  assert.equal(hit.length, 1, `exactly one cursor row mentioning "${marker}"`);
  return hit[0];
}

// --- HAPPY: attached-file PII flags the row, without dumping the file ---------
// The typed query is clean; the leaked email rides in <attached_files>. The row
// must show PII yes + EMAIL, be marked `unchecked`, and NOT expose the file dump
// or the raw address.
test("happy: attached-file PII is flagged unchecked without dumping the file", async () => {
  const before = (await cursorEntries()).length;

  const { dir, transcript } = makeCase("happy", [
    userLine(
      `<timestamp>Tue Jul 28 2026</timestamp>\n` +
        `<user_query>\nthis is just a test, what do you think\n</user_query>\n` +
        `<attached_files>\nCustomer record\nemail: ${EMAIL}\ncard: ${CARD}\n</attached_files>`,
    ),
    assistantLine("Sure, I looked at the attached record."),
    TURN_END,
  ]);

  const r = await runHook(
    JSON.stringify({ hook_event_name: "stop", transcript_path: transcript, model: "claude-sonnet-5" }),
    { stateDir: dir },
  );
  assert.equal(r.status, 0, "logging must never fail the session");

  assert.equal((await cursorEntries()).length, before + 1, "one CHAT row for the turn");
  const e = await cursorEntryWith("this is just a test");

  // The leak is now VISIBLE: PII yes, the type is named, and the row is flagged.
  assert.equal(e.piiDetected, true, "attached-file PII surfaces on the row");
  assert.ok(e.matchedRules.inbound.EMAIL >= 1, "EMAIL counted from the attachment");
  assert.ok(e.matchedRules.inbound.CREDIT_CARD >= 1, "card counted from the attachment");
  assert.equal(e.unchecked, true, "attachment content was never gated -> unchecked");

  // The displayed prompt is still just what the user typed — no file dump.
  assert.match(e.clean.userPrompt, /this is just a test/);
  assert.ok(!e.clean.userPrompt.includes("Customer record"), "the attachment is not dumped into the prompt view");
  assert.ok(!e.clean.userPrompt.includes("attached_files"), "no envelope leaks into the view");

  // And absolutely no raw PII is stored anywhere in the entry.
  assert.ok(!JSON.stringify(e).includes(EMAIL), "no raw email stored");
  assert.ok(!JSON.stringify(e).replace(/\s/g, "").includes(CARD.replace(/\s/g, "")), "no raw card stored");
});

// --- FAILURE: the user_email envelope must NOT flag every turn ----------------
// Cursor stamps the account `user_email` on every prompt (outside <attached_files>).
// A naive "scan the whole message" audit would then flag EVERY turn as a PII leak.
// Extraction targets <attached_files> ONLY: a clean attachment beside a stamped
// user_email must produce a clean, un-flagged row.
test("failure: a stamped user_email outside attached_files does not flag the turn", async () => {

  const { dir, transcript } = makeCase("envelope", [
    userLine(
      `<user_query>\njust a normal question\n</user_query>\n` +
        `<additional_data>user_email: ${USER_EMAIL}</additional_data>\n` +
        `<attached_files>\nconst x = 1; // nothing sensitive here\n</attached_files>`,
    ),
    assistantLine("Here is my answer."),
    TURN_END,
  ]);

  const r = await runHook(
    JSON.stringify({ hook_event_name: "stop", transcript_path: transcript }),
    { stateDir: dir },
  );
  assert.equal(r.status, 0);

  const e = await cursorEntryWith("just a normal question");
  assert.equal(e.piiDetected, false, "the stamped user_email must not be scanned");
  assert.ok(!e.unchecked, "a clean attachment beside an envelope email is not flagged");
  assert.ok(!JSON.stringify(e).includes(USER_EMAIL), "and the account email is never stored");
});

// --- EDGE: an APPROVED typed prompt must not clear the attachment flag --------
// This is the exact live bug (12:32): the typed text ("this is for test ...") was
// ALLOWED by the block gate, so it is in the approval ledger — yet the selected
// file rode along and leaked. Approval of the typed text must NOT suppress the
// attachment's `unchecked` flag. Also proves multiple <attached_files> blocks are
// all scanned.
test("edge: an approved typed prompt still yields unchecked when an attachment leaks", async () => {

  const typed = "explain this code to me";
  const { dir, transcript } = makeCase("approved", [
    userLine(
      `<user_query>\n${typed}\n</user_query>\n` +
        `<attached_files>\nfirst file: nothing here\n</attached_files>\n` +
        `<attached_files>\nsecond file email: ${EMAIL}\n</attached_files>`,
    ),
    assistantLine("Here's the explanation."),
    TURN_END,
  ]);
  // Seed the approval ledger as though the block hook allowed the typed prompt.
  fs.writeFileSync(
    path.join(dir, APPROVED_FILE),
    JSON.stringify({ hashes: [promptHash(typed)] }),
  );

  const r = await runHook(
    JSON.stringify({ hook_event_name: "stop", transcript_path: transcript }),
    { stateDir: dir },
  );
  assert.equal(r.status, 0);

  const e = await cursorEntryWith("explain this code");
  assert.equal(e.piiDetected, true, "the second attachment's email is caught");
  assert.equal(e.unchecked, true, "approval of the typed text must not clear an attachment leak");
  assert.ok(!JSON.stringify(e).includes(EMAIL), "no raw email stored");
});
