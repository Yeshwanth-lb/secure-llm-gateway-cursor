#!/usr/bin/env node
// Cursor Code-Guard SCAN hook (Checkpoint 2b) — event: afterFileEdit.
//
// Fires after Cursor's agent edits a file. Reads the file and POSTs it to
// `POST /action-guard/scan` (surface "cursor"), which scans it (Tier 1 ‖ Tier 2)
// and accumulates findings under the conversation id. A Cursor `stop` hook would
// then drain them via /action-guard/pending into a `followup_message`; this build
// ships the SCAN half (the accumulator + audit), matching the spec's §8 file list.
//
// FAIL-SAFE + STDOUT HYGIENE: afterFileEdit is observational (nothing to block),
// so this ALWAYS prints exactly ONE JSON line and exits 0 — even on error. Cursor
// treats malformed/multiline stdout as a hook failure, so we emit a single `{}`.
// Diagnostics go to stderr only.
import fs from "node:fs";
import { postJson, BASE_URL, log } from "./lib.mjs";

const MAX_STDIN = 512 * 1024;
const MAX_CONTENT = 256 * 1024;

function done() {
  process.stdout.write("{}\n"); // exactly one JSON line
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
  } catch {
    return done();
  }
  if (!ctx || typeof ctx !== "object") return done();

  const filePath =
    (typeof ctx.file_path === "string" && ctx.file_path) ||
    (ctx.tool_input && typeof ctx.tool_input.file_path === "string" && ctx.tool_input.file_path) ||
    "";
  const conversationId = ctx.conversation_id || ctx.session_id || ctx.generation_id || "";
  if (!filePath || !conversationId) return done();

  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
    if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT);
  } catch {
    return done();
  }

  try {
    await postJson("/action-guard/scan", {
      conversation_id: conversationId,
      file_path: filePath,
      content,
      surface: "cursor",
    });
  } catch (e) {
    log(`cursor-action-scan-hook: /action-guard/scan unreachable at ${BASE_URL} (${e.message}) — skipping (fail-safe)`);
  }
  done();
}

main().catch((e) => {
  log(`cursor-action-scan-hook: unexpected error (${e?.message ?? e}) — skipping (fail-safe)`);
  done();
});
