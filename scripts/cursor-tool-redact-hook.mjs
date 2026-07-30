#!/usr/bin/env node
// Cursor tool-data SCRUB hook (Phase L). Unlike the block-only Phase K hook,
// Cursor's `preToolUse`/`postToolUse` hooks can REWRITE content, so this hook
// scrubs PII out of tool data in transit via the gateway's POST /redact:
//   - preToolUse  -> { permission:"allow", updated_input: <scrubbed> }
//   - postToolUse -> { updated_mcp_tool_output: <scrubbed> }
// It fires only around TOOL calls (never the chat), and only when a tool runs.
//
// Fail-closed (the rewrite hooks can't all block, so never pass raw on error):
//   - preToolUse  : on any error -> DENY the tool call (supports allow/deny).
//   - postToolUse : cannot block  -> WITHHOLD the output (placeholder), never raw.
//
// Diagnostics -> stderr; the JSON decision -> stdout. Raw tool data is sent to
// the loopback gateway only; the gateway never logs it. Set CURSOR_HOOK_CAPTURE=1
// to dump the raw stdin payload to stderr once, to pin Cursor's live field names.
import fs from "node:fs";
import path from "node:path";
import { postJson, BASE_URL, STATE_DIR, log } from "./lib.mjs";

// One-off schema capture: enable by `touch ~/.secure-llm-gateway/hook-capture`
// (or CURSOR_HOOK_CAPTURE=1). Raw stdin is appended to hook-capture.log so the
// exact preToolUse/postToolUse field names can be confirmed from a live Cursor
// tool call. Remove the flag file to stop. Capture only — no effect on scrubbing.
// NOTE: this capture writes RAW stdin, so it has its OWN flag. The prompt hook's
// `hook-capture` flag enables a shape-only capture (no payload) and must not
// silently turn raw dumping on here as well.
const CAPTURE_FLAG = path.join(STATE_DIR, "hook-capture-raw");
const CAPTURE_LOG = path.join(STATE_DIR, "hook-capture.log");

const MAX_STDIN = 2 * 1024 * 1024; // tool outputs can be large
const WITHHELD = "[tool output withheld: PII gateway unreachable — fail-closed]";

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

function emit(obj, exitCode = 0) {
  // Write the WHOLE payload SYNCHRONOUSLY, then exit. emit() must stay terminal
  // (the hook's control flow relies on it not returning), so we can't defer the
  // exit to an async write callback — that would let execution fall through to a
  // second emit() and print two JSON objects. But `process.stdout.write()` to a
  // pipe is asynchronous once the payload exceeds the OS pipe buffer (~64 KB), and
  // `process.exit()` right after it discards the un-flushed tail — so a large
  // scrubbed `updated_input` (a big file rewrite that legitimately contained an
  // email/IP) reached Cursor TRUNCATED and unparseable, failing the tool closed.
  // fs.writeSync to fd 1 blocks until each chunk lands; loop over partial writes /
  // EAGAIN (a non-blocking pipe that's momentarily full) so nothing is dropped.
  const buf = Buffer.from(JSON.stringify(obj) + "\n");
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      if (e && e.code === "EAGAIN") continue; // pipe full — retry until the reader drains
      break; // any other write error: give up rather than spin
    }
  }
  process.exit(exitCode);
}

// Pull the first defined value among candidate keys (Cursor's exact field name
// for tool input/output is confirmed at runtime via capture mode; we accept the
// documented + likely aliases so a schema tweak doesn't silently pass raw data).
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return { key: k, value: obj[k] };
  }
  return { key: null, value: undefined };
}

const raw = await readStdin();

if (process.env.CURSOR_HOOK_CAPTURE === "1" || fs.existsSync(CAPTURE_FLAG)) {
  try {
    fs.appendFileSync(CAPTURE_LOG, `\n=== ${new Date().toISOString()} ===\n${raw.slice(0, 16384)}\n`);
  } catch { /* capture is best-effort */ }
  log(`cursor-tool-redact-hook: captured raw stdin -> ${CAPTURE_LOG}`);
}

let ctx;
try {
  ctx = JSON.parse(raw);
  if (!ctx || typeof ctx !== "object") throw new Error("not an object");
} catch {
  // Unparseable input: we don't know the event. Fail closed with a deny shape;
  // postToolUse ignores `permission`, so also send a withheld output.
  log("cursor-tool-redact-hook: unreadable hook input — failing closed");
  emit({ permission: "deny", updated_mcp_tool_output: WITHHELD }, 2);
}

const event = String(ctx.hook_event_name ?? "");

// Ask the gateway to scrub a text-or-structured payload. Returns the scrubbed
// value + whether any PII was found. Throws on transport/HTTP error.
async function scrub(payload) {
  // `source` labels the counts-only audit entry the gateway records (no text).
  const toolName = typeof ctx.tool_name === "string" ? `:${ctx.tool_name}` : "";
  const source = `cursor:${event}${toolName}`;
  const body = typeof payload === "string" ? { text: payload, source } : { value: payload, source };
  const { status, json } = await postJson("/redact", body);
  if (status !== 200 || !json) throw new Error(`status ${status}`);
  return { redacted: json.redacted, piiDetected: !!json.piiDetected, matched: json.matched || {} };
}

if (event === "preToolUse") {
  const { value: input } = pick(ctx, ["tool_input", "input", "arguments", "toolInput", "params"]);
  if (input === undefined) emit({ permission: "allow" }); // nothing to scrub
  try {
    const { redacted, piiDetected, matched } = await scrub(input);
    if (!piiDetected) emit({ permission: "allow" }); // untouched
    log(`cursor-tool-redact-hook: scrubbed preToolUse input (${Object.keys(matched).join(",")})`);
    emit({ permission: "allow", updated_input: redacted });
  } catch (e) {
    log(`cursor-tool-redact-hook: /redact failed at ${BASE_URL} (${e.message}) — DENY tool call`);
    emit({ permission: "deny", user_message: `PII gateway unreachable; tool blocked (fail-closed).` }, 2);
  }
}

if (event === "postToolUse") {
  const { value: output } = pick(ctx, [
    "tool_output", "output", "mcp_tool_output", "tool_response", "result", "response",
  ]);
  if (output === undefined) emit({}); // nothing to scrub
  try {
    const { redacted, piiDetected, matched } = await scrub(output);
    if (!piiDetected) emit({}); // untouched — let Cursor use the original
    log(`cursor-tool-redact-hook: scrubbed postToolUse output (${Object.keys(matched).join(",")})`);
    emit({ updated_mcp_tool_output: redacted });
  } catch (e) {
    log(`cursor-tool-redact-hook: /redact failed at ${BASE_URL} (${e.message}) — WITHHOLD output`);
    emit({ updated_mcp_tool_output: WITHHELD, additional_context: "Tool output withheld: PII gateway unreachable." });
  }
}

// Unknown event (not wired) — do nothing, let Cursor proceed.
emit({});
