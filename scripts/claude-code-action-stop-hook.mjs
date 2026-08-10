#!/usr/bin/env node
// Claude Code Code-Guard STOP hook (Checkpoint 2b) — event: Stop.
//
// Fires when Claude Code believes the turn is done. It drains the findings the
// SCAN hook accumulated this turn (GET /action-guard/pending, which reads + CLEARS
// once) and, if any remain, blocks the stop with a "regenerate securely" reason so
// the agent fixes the code and edits again — looping until clean or the platform
// cap (8) is hit.
//
// stop_hook_active IS A CORRECTNESS REQUIREMENT, NOT A NICETY. Claude Code sets it
// true on a Stop that was itself triggered by a previous Stop-hook block. If we did
// not short-circuit on it we would re-block our own re-entry and spin the turn (a
// billing-safety hazard). So the FIRST thing this hook does, before ANY network
// call, is: if stop_hook_active -> exit 0.
//
// FAIL-SAFE: Code Guard is observational — a dead/erroring gateway must NOT trap the
// turn, so any error exits 0 with no block. Diagnostics -> stderr.
import { getJson, BASE_URL, log } from "./lib.mjs";

const MAX_STDIN = 512 * 1024;

function passThrough() {
  process.exit(0); // allow the stop (no block decision)
}
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
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
  let ctx = {};
  try {
    ctx = JSON.parse(raw) || {};
  } catch {
    return passThrough(); // unreadable -> don't trap the turn
  }

  // FIRST LINE OF LOGIC (billing-safety): already looping -> let it stop.
  if (ctx.stop_hook_active === true) return passThrough();

  const conversationId = ctx.session_id || ctx.conversation_id || "";
  if (!conversationId) return passThrough();

  let json;
  try {
    const r = await getJson(`/action-guard/pending?conversation_id=${encodeURIComponent(conversationId)}`);
    if (r.status !== 200 || !r.json) throw new Error(`status ${r.status}`);
    json = r.json;
  } catch (e) {
    log(`claude-code-action-stop-hook: /action-guard/pending unreachable at ${BASE_URL} (${e.message}) — not blocking (fail-safe)`);
    return passThrough();
  }

  if (json.count > 0 && typeof json.message === "string" && json.message !== "") {
    log(`claude-code-action-stop-hook: ${json.count} unresolved finding(s) — requesting regenerate`);
    return block(json.message);
  }
  passThrough();
}

main().catch((e) => {
  log(`claude-code-action-stop-hook: unexpected error (${e?.message ?? e}) — not blocking (fail-safe)`);
  passThrough();
});
