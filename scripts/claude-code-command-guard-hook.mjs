#!/usr/bin/env node
// Claude Code command-guard hook (Checkpoint 2 v1) — event: PreToolUse, matcher "Bash".
//
// Fires before Claude Code runs a Bash command. It POSTs the command to the
// gateway's deterministic `POST /command-guard` and maps the verdict onto Claude
// Code's PreToolUse decision:
//   allow -> exit 0 (no decision; normal permission flow)
//   ask   -> {permissionDecision:"ask"}  (Claude Code prompts the user)
//   deny  -> {permissionDecision:"deny"} + reason  (blocked)
//
// FAIL-CLOSED — CRITICAL. Claude Code's platform default on hook error is fail-OPEN:
// exit 1 / any nonzero-non-2 => the command RUNS. There is NO failClosed flag. So
// this hook MUST manufacture fail-closed itself: any error (gateway unreachable,
// unreadable stdin, non-200, timeout) emits a `deny` decision. It must NEVER fall
// through to a natural nonzero exit while a command is pending. `postJson` rejects
// on unreachable/timeout (8s) -> we catch -> deny.
//
// stdout carries the JSON decision only; diagnostics go to stderr.
import { postJson, BASE_URL, log } from "./lib.mjs";

const MAX_STDIN = 512 * 1024;
const MAX_COMMAND = 64 * 1024;

/** Emit a PreToolUse deny decision and exit 0 (JSON at exit 0 is honored). */
function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          reason ?? "Command Guard denied this command (fail-closed).",
      },
    }) + "\n",
  );
  process.exit(0);
}
/** Emit an ask decision (Claude Code asks the user to confirm). */
function ask(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason ?? "Confirm this command.",
      },
    }) + "\n",
  );
  process.exit(0);
}
/** Allow: emit nothing, exit 0 (normal permission flow). */
function allow() {
  process.exit(0);
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

async function main() {
  const raw = await readStdin();
  let ctx;
  try {
    ctx = JSON.parse(raw);
    if (!ctx || typeof ctx !== "object") throw new Error("not an object");
  } catch {
    // Unreadable input while a command is pending -> FAIL CLOSED (deny).
    log("claude-code-command-guard-hook: unreadable hook input — failing closed (deny)");
    deny("Command Guard could not read the tool input; denied by default.");
    return;
  }

  // Only gate Bash. Any other tool -> allow (this guard is shell-only).
  if (ctx.tool_name && ctx.tool_name !== "Bash") allow();

  const command =
    ctx.tool_input && typeof ctx.tool_input.command === "string"
      ? ctx.tool_input.command.slice(0, MAX_COMMAND)
      : "";
  if (command.trim() === "") allow(); // nothing to run

  let result;
  try {
    const { status, json } = await postJson("/command-guard", { command, surface: "claude-code" });
    if (status !== 200 || !json) throw new Error(`status ${status}`);
    result = json;
  } catch (e) {
    log(`claude-code-command-guard-hook: gateway /command-guard unreachable at ${BASE_URL} (${e.message}) — failing closed (deny)`);
    deny("Command Guard is unreachable; denied by default (fail-closed).");
    return;
  }

  if (result.permission === "deny") {
    log(`claude-code-command-guard-hook: DENY (${result.category ?? "policy"})`);
    deny(result.agent_message || result.user_message);
    return;
  }
  if (result.permission === "ask") {
    log(`claude-code-command-guard-hook: ASK (${result.category ?? "policy"})`);
    ask(result.agent_message || result.user_message);
    return;
  }
  allow();
}

// Any unforeseen throw anywhere -> FAIL CLOSED. Never leave a command ungated on a crash.
main().catch((e) => {
  log(`claude-code-command-guard-hook: unexpected error (${e?.message ?? e}) — failing closed (deny)`);
  deny("Command Guard hit an unexpected error; denied by default.");
});
