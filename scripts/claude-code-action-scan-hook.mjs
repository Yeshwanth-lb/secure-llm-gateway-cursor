#!/usr/bin/env node
// Claude Code Code-Guard SCAN hook (Checkpoint 2b) — event: PostToolUse, matcher "Edit|Write".
//
// Fires AFTER Claude Code edits/writes a file. It reads the file the agent just
// changed and POSTs it to `POST /action-guard/scan`, which scans it (Tier 1 ‖
// Tier 2) and ACCUMULATES any findings under the session id. The Stop hook drains
// them at end of turn to build the "regenerate securely" follow-up.
//
// FAIL-SAFE — the deliberate inverse of the command-guard hook. Code Guard is
// OBSERVATIONAL: the file is already on disk, there is nothing to block. So this
// hook NEVER emits a block/deny and ALWAYS exits 0, even on error (unreachable
// gateway, unreadable file/stdin). A scan that can't run must not break the turn.
//
// PostToolUse only gives the diff metadata (file_path) — not the file content — so
// we read the file ourselves (spec §4). Diagnostics -> stderr; stdout stays clean.
import fs from "node:fs";
import { postJson, BASE_URL, log } from "./lib.mjs";

const MAX_STDIN = 512 * 1024;
const MAX_CONTENT = 256 * 1024; // cap the bytes we ship for a scan

function done() {
  process.exit(0); // always succeed — observational
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
  } catch {
    return done(); // unreadable input -> nothing to scan (fail-safe)
  }
  if (!ctx || typeof ctx !== "object") return done();

  const filePath =
    (ctx.tool_input && typeof ctx.tool_input.file_path === "string" && ctx.tool_input.file_path) ||
    (typeof ctx.file_path === "string" && ctx.file_path) ||
    "";
  const conversationId = ctx.session_id || ctx.conversation_id || "";
  if (!filePath || !conversationId) return done();

  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
    if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT);
  } catch {
    return done(); // deleted/binary/unreadable -> skip
  }

  try {
    await postJson("/action-guard/scan", {
      conversation_id: conversationId,
      file_path: filePath,
      content,
      surface: "claude-code",
    });
  } catch (e) {
    log(`claude-code-action-scan-hook: /action-guard/scan unreachable at ${BASE_URL} (${e.message}) — skipping (fail-safe)`);
  }
  done();
}

// Any unforeseen throw -> still succeed. Code Guard never blocks a turn.
main().catch((e) => {
  log(`claude-code-action-scan-hook: unexpected error (${e?.message ?? e}) — skipping (fail-safe)`);
  done();
});
