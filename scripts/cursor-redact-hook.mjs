#!/usr/bin/env node
// Cursor block-if-PII hook (Phase K). Cursor's native read/prompt hooks can only
// ALLOW or DENY — they cannot rewrite content (verified against cursor.com/docs/
// hooks; see CURSOR_INTEGRATION_PLAN §3). So this hook DETECTS PII (via the
// gateway's live rule set at POST /detect) and BLOCKS the action when found:
//   - beforeReadFile / beforeTabFileRead -> { permission: "allow" | "deny" }
//   - beforeSubmitPrompt                 -> { continue: true | false }
// Fail-closed: any error (gateway down, unreadable input) DENIES. Diagnostics go
// to stderr only; stdout carries the JSON decision.
import fs from "node:fs";
import { postJson, BASE_URL, log } from "./lib.mjs";

const MAX_STDIN = 512 * 1024;
const MAX_SCAN = 256 * 1024; // cap the text we scan (matches gateway snapshot budget)

/** Drain stdin (Cursor sends hook context JSON on stdin). */
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

/** Emit a decision for the given event and exit. `deny` chooses the block shape. */
function decide(event, deny, message) {
  const isPrompt = event === "beforeSubmitPrompt";
  const out = isPrompt
    ? { continue: !deny }
    : { permission: deny ? "deny" : "allow" };
  if (deny && message) out.user_message = message;
  process.stdout.write(JSON.stringify(out) + "\n");
  // exit 2 on deny doubly signals a block (Cursor treats exit 2 as deny); exit 0
  // on allow so the JSON is consumed normally.
  process.exit(deny ? 2 : 0);
}

const raw = await readStdin();
let ctx;
try {
  ctx = JSON.parse(raw);
  if (!ctx || typeof ctx !== "object") throw new Error("not an object");
} catch {
  // Unparseable hook input -> fail closed. No event known; emit a generic deny.
  log("cursor-redact-hook: unreadable hook input — failing closed (deny)");
  process.stdout.write(JSON.stringify({ permission: "deny", continue: false }) + "\n");
  process.exit(2);
}

const event = String(ctx.hook_event_name ?? "");

// --- extract the text to scan for this event -------------------------------
let text = "";
try {
  if (event === "beforeSubmitPrompt") {
    text = typeof ctx.prompt === "string" ? ctx.prompt : "";
  } else {
    // beforeReadFile / beforeTabFileRead: prefer inlined content, else read disk.
    if (typeof ctx.content === "string") {
      text = ctx.content;
    } else if (typeof ctx.file_path === "string" && ctx.file_path) {
      text = fs.readFileSync(ctx.file_path, "utf8");
    }
  }
} catch (e) {
  log(`cursor-redact-hook: could not read content (${e.message}) — failing closed (deny)`);
  decide(event, true, "Could not verify file for PII; blocked by policy.");
}

if (text.length > MAX_SCAN) text = text.slice(0, MAX_SCAN);

// Nothing to scan -> allow (an empty read/prompt can't leak).
if (text.trim() === "") decide(event, false);

// --- ask the gateway (live rules) whether this text contains PII ------------
let result;
try {
  const { status, json } = await postJson("/detect", { text });
  if (status !== 200 || !json) throw new Error(`status ${status}`);
  result = json;
} catch (e) {
  log(`cursor-redact-hook: gateway /detect unreachable at ${BASE_URL} (${e.message}) — failing closed (deny)`);
  decide(event, true, `PII gateway unreachable at ${BASE_URL}; blocked by policy (fail-closed).`);
}

if (result.piiDetected) {
  const types = Object.keys(result.matched || {}).join(", ") || "PII";
  const where = event === "beforeSubmitPrompt" ? "your prompt" : ctx.file_path || "this file";
  log(`cursor-redact-hook: blocked ${event} — detected ${types} in ${where}`);
  decide(
    event,
    true,
    `Blocked: detected ${types} in ${where}. Remove or redact it before continuing (the gateway cannot silently scrub file reads or prompts — Cursor only allows block/allow here).`,
  );
}

decide(event, false);
