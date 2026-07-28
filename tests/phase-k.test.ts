// ===== PHASE K TESTS — Cursor block-if-PII hook =============================
// The hook can only ALLOW or DENY (Cursor's native read/prompt hooks cannot
// rewrite content). It DETECTS PII via the gateway's POST /detect and blocks
// when found; fail-closed on any error. Tests spawn the REAL hook script as a
// subprocess against a REAL gateway, feeding hook-context JSON on stdin.
//
// PII fixtures are built from fragments at runtime so no full literal appears in
// source.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../secure-llm-gateway.ts";

const HOOK = fileURLToPath(new URL("../scripts/cursor-redact-hook.mjs", import.meta.url));

// Runtime-constructed secrets (never a full literal in source).
const API_KEY = "sk-ant-" + "A1b2C3d4E5f6G7h8J9k0"; // matches API_KEY rule (>=16 body chars)
const EMAIL = "test.user" + "@" + "example.com";

let server: ReturnType<typeof createGatewayServer>;
let port: number;
let tmpDir: string;

before(async () => {
  server = createGatewayServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-k-"));
});

after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Run the hook with the given stdin, pointed at the test gateway. Uses async
 *  spawn (NOT spawnSync) so the in-process gateway's event loop stays free to
 *  answer the hook's /detect request — spawnSync would deadlock the parent. */
function runHook(input: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: String(port),
        GATEWAY_ENV_BOOTSTRAPPED: "1", // skip .env file loading — hermetic
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

// --- HAPPY: file read gated — PII denied, clean allowed ------------------------
test("happy: beforeReadFile denies a file containing PII, allows a clean file", async () => {
  const dirty = path.join(tmpDir, "secrets.txt");
  fs.writeFileSync(dirty, `const key = "${API_KEY}"; // contact ${EMAIL}\n`);
  const clean = path.join(tmpDir, "clean.txt");
  fs.writeFileSync(clean, "export const add = (a, b) => a + b;\n");

  const denied = await runHook(JSON.stringify({ hook_event_name: "beforeReadFile", file_path: dirty }));
  const dJson = JSON.parse(denied.stdout);
  assert.equal(dJson.permission, "deny");
  assert.ok(typeof dJson.user_message === "string" && dJson.user_message.length > 0);
  assert.notEqual(denied.status, 0, "deny signals a block via non-zero exit too");

  const allowed = await runHook(JSON.stringify({ hook_event_name: "beforeReadFile", file_path: clean }));
  const aJson = JSON.parse(allowed.stdout);
  assert.equal(aJson.permission, "allow");
  assert.equal(allowed.status, 0);
});

// --- FAILURE: malformed stdin -> fail closed (non-zero exit) -------------------
test("failure: unparseable hook input fails closed", async () => {
  const r = await runHook("this is not valid json {{{");
  assert.notEqual(r.status, 0, "malformed input must fail closed (non-zero exit)");
  // still emits a machine-readable deny on stdout
  const j = JSON.parse(r.stdout);
  assert.ok(j.permission === "deny" || j.continue === false);
});

// --- REGRESSION: @-mention bypass (found 2026-07-27) --------------------------
// Attaching a file/selection with `@name (1-6)` inlines its content into the
// request WITHOUT a beforeReadFile event, and beforeSubmitPrompt receives only
// the mention TEXT — `attachments` carries just `type:"rule"` path refs, never
// the mentioned file. Live capture proved raw PII reached the model this way.
// The prompt hook must therefore resolve @-mentions itself and scan those files.
test("regression: beforeSubmitPrompt blocks PII in an @-mentioned file (attachment bypass)", async () => {
  const dirty = path.join(tmpDir, "mentioned-secrets.txt");
  fs.writeFileSync(dirty, `customer email: ${EMAIL}\n`);

  // Line-range form — exactly what leaked live.
  const ranged = await runHook(
    JSON.stringify({
      hook_event_name: "beforeSubmitPrompt",
      prompt: "@mentioned-secrets.txt (1-6) what about now",
      workspace_roots: [tmpDir],
      user_email: EMAIL, // Cursor stamps this on EVERY prompt
      attachments: [{ type: "rule", file_path: "CLAUDE.md" }],
    }),
  );
  const rJson = JSON.parse(ranged.stdout);
  assert.equal(rJson.continue, false, "@-mentioned file with PII must be blocked");
  assert.match(rJson.user_message, /mentioned-secrets\.txt/);

  // Bare mention + absolute-path mention must be caught too.
  const bare = await runHook(
    JSON.stringify({
      hook_event_name: "beforeSubmitPrompt",
      prompt: "@mentioned-secrets.txt summarize this",
      workspace_roots: [tmpDir],
      user_email: EMAIL,
    }),
  );
  assert.equal(JSON.parse(bare.stdout).continue, false);

  const abs = await runHook(
    JSON.stringify({
      hook_event_name: "beforeSubmitPrompt",
      prompt: `look at @${dirty} please`,
      workspace_roots: [tmpDir],
      user_email: EMAIL,
    }),
  );
  assert.equal(JSON.parse(abs.stdout).continue, false);
});

// --- REGRESSION: pending-message bypass (found live 2026-07-27) --------------
// A DENY stops that send but does NOT remove the message from the chat — Cursor
// delivers it with the NEXT approved prompt, which the hook never re-checks
// (`prompt` holds only the newly typed text). Proved live from the capture log:
// prompt(27) -> DENY, then prompt(22) -> ALLOW, and BOTH reached the model.
// Pending messages are visible in the transcript after the last `turn_ended`.
test("regression: a clean prompt is blocked while a denied message is still pending", async () => {
  const transcript = path.join(tmpDir, "pending.jsonl");
  const userEntry = (q: string) =>
    JSON.stringify({
      role: "user",
      // Cursor wraps the typed text in its context envelope.
      message: { content: [{ type: "text", text: `<timestamp>t</timestamp>\n<user_query>\n${q}\n</user_query>` }] },
    });

  // A completed turn, then a blocked-but-retained message sitting after it.
  fs.writeFileSync(
    transcript,
    [
      userEntry("earlier question"),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "answer" }] } }),
      JSON.stringify({ type: "turn_ended", status: "success" }),
      userEntry(`my address is ${EMAIL}`), // denied earlier, still in the chat
    ].join("\n") + "\n",
  );

  const blocked = await runHook(
    JSON.stringify({
      hook_event_name: "beforeSubmitPrompt",
      prompt: "did it work",
      transcript_path: transcript,
      workspace_roots: [tmpDir],
      user_email: EMAIL,
    }),
  );
  const bJson = JSON.parse(blocked.stdout);
  assert.equal(bJson.continue, false, "must not send while PII is pending in the chat");
  assert.match(bJson.user_message, /pending/i);
  assert.match(bJson.user_message, /Delete that message/i, "tells the user how to clear it");

  // Once the pending turn completes (or the message is gone), sending resumes.
  fs.appendFileSync(transcript, JSON.stringify({ type: "turn_ended", status: "success" }) + "\n");
  const allowed = await runHook(
    JSON.stringify({
      hook_event_name: "beforeSubmitPrompt",
      prompt: "did it work",
      transcript_path: transcript,
      workspace_roots: [tmpDir],
      user_email: EMAIL,
    }),
  );
  assert.equal(JSON.parse(allowed.stdout).continue, true);
  assert.equal(allowed.status, 0);
});

// The false-positive trap: Cursor sends its own `user_email` on every prompt, so
// a whole-payload scan would deny EVERY message. Only prompt text + resolved
// @-mention files may be scanned. Unresolvable tokens (@Web, @Symbol) are skipped.
test("regression: prompt hook ignores Cursor's own user_email and unresolvable @tokens", async () => {
  const clean = path.join(tmpDir, "clean-mention.txt");
  fs.writeFileSync(clean, "export const sub = (a, b) => a - b;\n");

  const r = await runHook(
    JSON.stringify({
      hook_event_name: "beforeSubmitPrompt",
      prompt: "@clean-mention.txt @Web @SomeSymbol @missing-file.txt summarize this",
      workspace_roots: [tmpDir],
      user_email: EMAIL, // must NOT trigger a block
      transcript_path: `/tmp/transcript-${EMAIL}.jsonl`, // nor must this
      attachments: [
        { type: "rule", file_path: "CLAUDE.md" },
        { type: "rule", file_path: "AGENTS.md" },
      ],
    }),
  );
  const j = JSON.parse(r.stdout);
  assert.equal(j.continue, true, "Cursor's own user_email must never block a prompt");
  assert.equal(r.status, 0);
});

// --- EDGE: beforeSubmitPrompt blocks a secret, allows a clean prompt ----------
test("edge: beforeSubmitPrompt blocks a prompt with a secret, allows a clean one", async () => {
  const blocked = await runHook(
    JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: `use this key ${API_KEY} please` }),
  );
  const bJson = JSON.parse(blocked.stdout);
  assert.equal(bJson.continue, false);
  assert.ok(typeof bJson.user_message === "string" && bJson.user_message.length > 0);

  const ok = await runHook(
    JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: "refactor the add function please" }),
  );
  const okJson = JSON.parse(ok.stdout);
  assert.equal(okJson.continue, true);
  assert.equal(ok.status, 0);
});
