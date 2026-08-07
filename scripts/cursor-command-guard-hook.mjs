#!/usr/bin/env node
// Cursor command-guard hook (Checkpoint 2 v1) — event: beforeShellExecution.
//
// Cursor runs this before executing any shell command the agent issues. It POSTs
// the command to the gateway's deterministic `POST /command-guard`, and relays the
// verdict to Cursor's permission field: `deny` (destructive) / `ask` (git history
// rewrite) / `allow`.
//
// FAIL-CLOSED — the DELIBERATE INVERSE of the prompt-guard hook (which fails OPEN).
// A missed destructive command is unrecoverable, so ANY error (gateway unreachable,
// unreadable stdin, non-200, timeout) returns `deny`. The hook entry is also wired
// `failClosed: true`, so a crash denies too. Cost of that posture: while the gateway
// is down, shell commands are blocked — accepted (a stale/absent guard must not let
// a destructive command through).
//
// KNOWN LIMIT (verified 2026-08-06): Cursor may IGNORE this verdict on allow-listed
// commands and in the sandboxed Agent shell (it runs `ask`/`deny` anyway). So this
// is best-effort enforcement + ALWAYS-logged (the gateway logs every deny/ask). Do
// not treat a green hook as a hard guarantee on Cursor.
//
// stdout carries EXACTLY one JSON object; diagnostics go to stderr; we exit 0 even
// on deny (a non-zero exit makes Cursor treat the hook as crashed).
import { postJson, BASE_URL, log } from "./lib.mjs";

const MAX_STDIN = 512 * 1024;
const MAX_COMMAND = 64 * 1024;

/** Emit a decision object and exit 0 (Cursor reads permission from stdout). */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
}
function allow() {
  emit({ permission: "allow" });
}
/** The fail-closed default. */
function deny(userMessage, agentMessage) {
  emit({
    permission: "deny",
    user_message: userMessage ?? "Blocked by Command Guard (fail-closed).",
    agent_message: agentMessage ?? "Command Guard denied this command. Ask the user to run it if it is safe.",
  });
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let s = "";
  await new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      s += c;
      if (s.length > MAX_STDIN) process.stdin.destroy();
    });
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
    process.stdin.resume();
  });
  return s;
}

const raw = await readStdin();
let ctx;
try {
  ctx = JSON.parse(raw);
  if (!ctx || typeof ctx !== "object") throw new Error("not an object");
} catch {
  // Unreadable hook input -> FAIL CLOSED (deny), unlike the prompt-guard hook.
  log("cursor-command-guard-hook: unreadable hook input — failing closed (deny)");
  deny();
}

const command = typeof ctx.command === "string" ? ctx.command.slice(0, MAX_COMMAND) : "";
if (command.trim() === "") allow(); // nothing to run

let result;
try {
  const { status, json } = await postJson("/command-guard", { command, surface: "cursor" });
  if (status !== 200 || !json) throw new Error(`status ${status}`);
  result = json;
} catch (e) {
  log(`cursor-command-guard-hook: gateway /command-guard unreachable at ${BASE_URL} (${e.message}) — failing closed (deny)`);
  deny();
}

if (result.permission === "deny") {
  log(`cursor-command-guard-hook: DENY (${result.category ?? "policy"})`);
  deny(result.user_message, result.agent_message);
}
if (result.permission === "ask") {
  log(`cursor-command-guard-hook: ASK (${result.category ?? "policy"})`);
  emit({
    permission: "ask",
    user_message: result.user_message ?? "Confirm this command.",
    agent_message: result.agent_message ?? "",
  });
}
allow();
