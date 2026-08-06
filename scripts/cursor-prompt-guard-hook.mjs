#!/usr/bin/env node
// Cursor prompt-guard hook (Checkpoint 1, Build 2) — event: beforeSubmitPrompt.
//
// CAPABILITY (fixed, verified 2026-08-05 against cursor.com/docs/hooks + memory
// `cursor-hooks-block-only`): beforeSubmitPrompt is a BLOCK-ONLY gate
// ({continue: true|false}). It CANNOT add context to a prompt. So this hook does
// LOG + severe-block ONLY. The actual Cursor guidance INJECTION is delivered by
// static `.cursor/rules/` (generated from src/guidance.ts by gen-cursor-rules.ts),
// which is always applied and cannot be skipped — that is the injection path.
//
// FAIL-OPEN — the DELIBERATE INVERSE of the PII `cursor-redact-hook.mjs`, which
// fails CLOSED. Any error (gateway unreachable, unreadable stdin, non-200,
// analyzer throw) returns {continue:true}. This is a guidance layer: a miss means
// "no guidance / not logged", never a dropped Cursor send. A blocked send only
// ever happens on a CONFIDENT severe-category detection from the gateway.
//
// Diagnostics go to stderr; stdout carries the JSON decision only.
import { postJson, BASE_URL, log } from "./lib.mjs";

const MAX_STDIN = 512 * 1024;
const MAX_PROMPT = 256 * 1024; // cap the text we send to the analyzer

/** Emit an allow decision and exit 0 (the fail-open default). */
function allow() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

/** Drain stdin (Cursor sends the hook context JSON on stdin). */
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
  // Unreadable hook input -> FAIL OPEN (unlike the PII hook, which denies).
  log("cursor-prompt-guard-hook: unreadable hook input — failing open (allow)");
  allow();
}

const prompt = typeof ctx.prompt === "string" ? ctx.prompt.slice(0, MAX_PROMPT) : "";
if (prompt.trim() === "") allow(); // nothing to analyze

let result;
try {
  const { status, json } = await postJson("/prompt-guard", { prompt, surface: "cursor-hook" });
  if (status !== 200 || !json) throw new Error(`status ${status}`);
  result = json;
} catch (e) {
  // Gateway down / unreachable -> FAIL OPEN. The send proceeds unguided rather
  // than being dropped; the static .cursor/rules baseline still steers the model.
  log(`cursor-prompt-guard-hook: gateway /prompt-guard unreachable at ${BASE_URL} (${e.message}) — failing open (allow)`);
  allow();
}

// Block ONLY on a confident severe-category detection (v1: none active, so this
// path stays dormant). Everything else is allowed — the decision was already
// logged server-side to the security log.
if (result.block === true) {
  const cats = Array.isArray(result.categories) ? result.categories.join(", ") : "policy";
  log(`cursor-prompt-guard-hook: blocked — severe category (${cats})`);
  process.stdout.write(
    JSON.stringify({
      continue: false,
      user_message: `Blocked by prompt-guard policy (${cats}). Rephrase or remove the disallowed request.`,
    }) + "\n",
  );
  process.exit(2);
}

allow();
