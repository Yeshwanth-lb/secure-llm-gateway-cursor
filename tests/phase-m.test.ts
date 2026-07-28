// ===== PHASE M TESTS — Cursor per-turn CHAT logging =========================
// Cursor chat never reaches the gateway (Cursor calls providers from its own
// cloud), so the inspector had no prompt/output view for Cursor. This hook
// replays each finished turn from the transcript Cursor writes locally
// (`transcript_path`) into POST /log-turn, which redacts server-side and stores
// redacted text only. Tests spawn the REAL hook against a REAL gateway.
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

const HOOK = fileURLToPath(new URL("../scripts/cursor-turn-log-hook.mjs", import.meta.url));

const EMAIL = "turn.user" + "@" + "example.com";
const SSN = "123" + "-" + "45" + "-" + "6789";

let server: ReturnType<typeof createGatewayServer>;
let port: number;
let tmpDir: string;

before(async () => {
  server = createGatewayServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-m-"));
});

after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Run the hook with the given stdin. `statePort` lets a test point the hook at a
 *  dead port to exercise the fail-open path. Async spawn (never spawnSync): the
 *  in-process gateway needs a free event loop to answer /log-turn. */
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
function toolLine() {
  return JSON.stringify({
    role: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { path: "/tmp/x" } }] },
  });
}
const TURN_END = JSON.stringify({ type: "turn_ended", status: "success" });

/** Write a transcript in its own state dir so each test dedupes independently. */
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

// --- HAPPY: a finished turn shows up as a CHAT row with a clean view ----------
test("happy: a finished Cursor turn is logged with redacted prompt + assistant output", async () => {
  // Cursor wraps the typed text in context blocks — the row should show the
  // message, not the envelope.
  const { dir, transcript } = makeCase("happy", [
    userLine(
      `<timestamp>Mon Jul 27 2026</timestamp>\n<user_query>\nmy email is ${EMAIL}, look at this\n</user_query>`,
    ),
    toolLine(),
    assistantLine(`I see the address ${EMAIL} in your message.`),
    TURN_END,
  ]);

  const r = await runHook(
    JSON.stringify({ hook_event_name: "stop", transcript_path: transcript, model: "claude-opus-5" }),
    { stateDir: dir },
  );
  assert.equal(r.status, 0, "logging must never fail the session");

  const entries = await cursorEntries();
  assert.equal(entries.length, 1, "exactly one CHAT row for the turn");
  const e = entries[0];
  assert.equal(e.method, "CHAT");
  assert.equal(e.model, "claude-opus-5");
  assert.equal(e.piiDetected, true);

  // Both halves present, and REDACTED — never the raw address.
  assert.match(e.clean.userPrompt, /REDACTED_PII_EMAIL/);
  assert.match(e.clean.assistantOutput, /REDACTED_PII_EMAIL/);
  assert.ok(!JSON.stringify(e).includes(EMAIL), "no raw PII anywhere in the stored entry");
  // The assistant text is real content, not a placeholder.
  assert.match(e.clean.assistantOutput, /I see the address/);
  // Cursor's context envelope is stripped — the row shows what was typed.
  assert.match(e.clean.userPrompt, /^my email is /);
  assert.ok(!e.clean.userPrompt.includes("<user_query>"), "envelope stripped");
  assert.ok(!e.clean.userPrompt.includes("<timestamp>"), "timestamp block stripped");
});

// --- FAILURE: nothing readable / gateway down -> fail OPEN, never crash -------
test("failure: missing transcript or dead gateway skips logging without breaking", async () => {
  const before = (await cursorEntries()).length;

  // No transcript_path at all.
  const noPath = await runHook(JSON.stringify({ hook_event_name: "stop" }));
  assert.equal(noPath.status, 0);

  // Path that doesn't exist.
  const missing = await runHook(
    JSON.stringify({ hook_event_name: "stop", transcript_path: path.join(tmpDir, "nope.jsonl") }),
  );
  assert.equal(missing.status, 0);

  // Unparseable stdin.
  const garbage = await runHook("not json at all {{{");
  assert.equal(garbage.status, 0);

  // Real transcript, but the gateway is unreachable — must not throw, and must
  // not mark the turn logged (it retries on the next fire).
  const { dir, transcript } = makeCase("down", [
    userLine("hello there"),
    assistantLine("hi"),
    TURN_END,
  ]);
  const dead = await runHook(
    JSON.stringify({ hook_event_name: "stop", transcript_path: transcript }),
    { port: 1, stateDir: dir },
  );
  assert.equal(dead.status, 0, "a logging failure must be fail-open");

  assert.equal((await cursorEntries()).length, before, "nothing logged on failure paths");

  // Now that the gateway is reachable again, the retained turn is picked up.
  const retry = await runHook(
    JSON.stringify({ hook_event_name: "stop", transcript_path: transcript }),
    { stateDir: dir },
  );
  assert.equal(retry.status, 0);
  assert.equal((await cursorEntries()).length, before + 1, "retry logs the withheld turn");
});

// --- REGRESSION: a COMPACTED transcript must still log new turns --------------
// Found live 2026-07-28: dedupe stored a COUNT of turns logged, which assumes the
// transcript only ever grows. Cursor compacts it (a long session is summarized and
// rewritten in place), so the counter ended up AHEAD of the content — 17 logged vs
// 6 present — and `turns.length <= already` silently stopped logging that session
// forever. Dedupe is now per-turn content hashes, which survive a rewrite.
test("regression: a compacted transcript keeps logging (counter ahead of content)", async () => {
  const before = (await cursorEntries()).length;

  const { dir, transcript } = makeCase("compact", [
    userLine("question one"),
    assistantLine("answer one"),
    TURN_END,
    userLine("question two"),
    assistantLine("answer two"),
    TURN_END,
    userLine("question three"),
    assistantLine("answer three"),
    TURN_END,
  ]);
  await runHook(JSON.stringify({ hook_event_name: "stop", transcript_path: transcript }), {
    stateDir: dir,
  });
  assert.equal((await cursorEntries()).length, before + 3, "three turns logged");

  // Cursor compacts: the file is REWRITTEN with fewer turns than we've logged —
  // one surviving old turn plus a brand-new one.
  fs.writeFileSync(
    transcript,
    [
      userLine("question three"),
      assistantLine("answer three"),
      TURN_END,
      userLine("a turn after compaction"),
      assistantLine("answered after compaction"),
      TURN_END,
    ].join("\n") + "\n",
  );

  const r = await runHook(
    JSON.stringify({ hook_event_name: "stop", transcript_path: transcript }),
    { stateDir: dir },
  );
  assert.equal(r.status, 0);

  const entries = await cursorEntries();
  assert.equal(entries.length, before + 4, "the post-compaction turn is logged, the survivor is not");
  const fresh = entries.filter((e) => String(e.clean?.userPrompt ?? "").includes("after compaction"));
  assert.equal(fresh.length, 1, "new turn logged exactly once");
  const survivor = entries.filter((e) => String(e.clean?.userPrompt ?? "").includes("question three"));
  assert.equal(survivor.length, 1, "the surviving old turn is not re-logged");
});

// --- REGRESSION: legacy COUNTER + compaction must not wedge logging forever ---
// The first compaction fix still wedged on the real live state: a legacy numeric
// counter (17) larger than the turns present (6) marked EVERY turn as already
// logged and returned before persisting, so each run redid that and nothing was
// ever logged again. Migration now leaves the newest turn loggable and always
// persists, converting the counter to hashes on the first run.
test("regression: a legacy counter ahead of a compacted transcript still logs the newest turn", async () => {
  const before = (await cursorEntries()).length;

  const { dir, transcript } = makeCase("legacy", [
    userLine("surviving old question"),
    assistantLine("surviving old answer"),
    TURN_END,
    userLine("the turn that just ended"),
    assistantLine("its answer"),
    TURN_END,
  ]);
  // Pre-compaction state: more turns counted than the file now holds.
  fs.writeFileSync(
    path.join(dir, "cursor-turnlog-state.json"),
    JSON.stringify({ [transcript]: 17 }),
  );

  const r = await runHook(
    JSON.stringify({ hook_event_name: "stop", transcript_path: transcript }),
    { stateDir: dir },
  );
  assert.equal(r.status, 0);

  const entries = await cursorEntries();
  assert.equal(entries.length, before + 1, "the newest turn is logged, older ones are not replayed");
  const logged = entries.filter((e) =>
    String(e.clean?.userPrompt ?? "").includes("the turn that just ended"),
  );
  assert.equal(logged.length, 1, "and it is the turn that just ended, not a survivor");

  // The counter must be converted to hashes, or the next run repeats the wedge.
  const state = JSON.parse(fs.readFileSync(path.join(dir, "cursor-turnlog-state.json"), "utf8"));
  assert.ok(Array.isArray(state[transcript]?.logged), "legacy counter migrated to hashes");

  // And a re-fire adds nothing.
  await runHook(JSON.stringify({ hook_event_name: "stop", transcript_path: transcript }), {
    stateDir: dir,
  });
  assert.equal((await cursorEntries()).length, before + 1, "re-fire after migration is a no-op");
});

// --- EDGE: re-fire dedupes; tool-only turns skipped; partial tail tolerated ---
test("edge: repeated fires never double-log, tool-only turns are skipped", async () => {
  const before = (await cursorEntries()).length;

  const { dir, transcript } = makeCase("edge", [
    userLine("first question"),
    assistantLine("first answer"),
    TURN_END,
    toolLine(), // a turn that produced only tool calls — nothing to show
    TURN_END,
    userLine(`second question with ${SSN}`),
    assistantLine("second answer"),
    TURN_END,
    userLine("in-flight turn, no turn_ended yet"), // must NOT be logged
    '{"role":"assistant","message":{"content":[{"type":"text","tex', // half-written line
  ]);

  const first = await runHook(
    JSON.stringify({ hook_event_name: "stop", transcript_path: transcript }),
    { stateDir: dir },
  );
  assert.equal(first.status, 0);
  const afterFirst = await cursorEntries();
  assert.equal(afterFirst.length, before + 2, "2 real turns; the tool-only turn is skipped");

  // Fire again with no new turns — must add nothing.
  const second = await runHook(
    JSON.stringify({ hook_event_name: "stop", transcript_path: transcript }),
    { stateDir: dir },
  );
  assert.equal(second.status, 0);
  assert.equal((await cursorEntries()).length, before + 2, "re-fire must not double-log");

  // The unfinished turn stayed out, and the SSN was redacted.
  const texts = (await cursorEntries()).map((e) => JSON.stringify(e)).join("\n");
  assert.ok(!texts.includes("in-flight turn"), "an unfinished turn is not logged");
  assert.ok(!texts.includes(SSN), "no raw SSN stored");
  assert.match(texts, /REDACTED_PII_SSN/);
});
