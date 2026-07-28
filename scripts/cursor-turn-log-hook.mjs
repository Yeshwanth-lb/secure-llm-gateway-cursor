#!/usr/bin/env node
// Cursor per-turn CHAT logging (Phase M). Cursor sends chat from its OWN cloud
// servers, so the gateway never sees the request/response bodies and the Traffic
// Inspector had no user-prompt / assistant-output view for Cursor — only
// counts-only HOOK rows. This is the Cursor analogue of the Gemini extension's
// /log-turn path: after a turn ends, read the turn out of the transcript Cursor
// itself writes (`transcript_path`, present in every hook payload) and POST it to
// the gateway, which REDACTS both halves server-side and stores redacted text only.
//
// Purely observational: it gates nothing and never blocks. Logging must not be
// able to break a session, so every failure path is fail-OPEN (skip the log) —
// unlike the block/scrub hooks, dropping a log entry leaks nothing.
//
// Transcript format (verified live 2026-07-27, Cursor 2.1.207):
//   {"role":"user","message":{"content":[{"type":"text","text":...}]}}
//   {"role":"assistant","message":{"content":[{"type":"text"|"tool_use",...}]}}
//   {"type":"turn_ended","status":"success"|"error"}
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { postJson, STATE_DIR, log } from "./lib.mjs";

const MAX_STDIN = 512 * 1024;
const MAX_TEXT = 200 * 1024; // per side; the gateway caps its own snapshot too
const STATE_FILE = path.join(STATE_DIR, "cursor-turnlog-state.json");
const MAX_TURN_HASHES = 500; // per transcript; keeps the dedupe state bounded
// Written by cursor-redact-hook.mjs on every ALLOW (hashes only, no prompt text).
const APPROVED_FILE = path.join(STATE_DIR, "cursor-approved-prompts.json");

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

/** Always neutral: this hook decides nothing. */
function done() {
  process.stdout.write("{}\n");
  process.exit(0);
}

/** Concatenated `text` blocks of a transcript message (tool_use blocks skipped —
 *  tool traffic is already covered by the preToolUse/postToolUse scrub). */
function textOf(entry) {
  const c = entry?.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/** Content of any `<attached_files>` blocks in a raw user message — the files
 *  Cursor auto-attaches when they are OPEN or SELECTED (no `@`-mention). This
 *  content rides to the model but never reaches the block hook, so it can't be
 *  gated (Phase O). Extract ONLY these blocks, never the whole message: Cursor
 *  stamps the account `user_email` elsewhere in the envelope, and scanning that
 *  would flag every single turn as a leak. */
function attachmentsOf(text) {
  return [...String(text).matchAll(/<attached_files>([\s\S]*?)<\/attached_files>/g)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Cursor wraps the typed message in context blocks (`<user_query>`, plus
 *  `<timestamp>`, attachments and open-file lists). Show what the user actually
 *  typed, mirroring how the Claude clean view strips Claude Code's boilerplate. */
function userMessage(text) {
  const queries = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((m) => m[1].trim());
  if (queries.length) return queries.filter(Boolean).join("\n\n");
  return text
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "")
    .replace(/<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>/g, "")
    .replace(/<attached_files>[\s\S]*?<\/attached_files>/g, "")
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, "")
    .trim();
}

/** Hashes of prompts the block/allow gate approved. Same digest as the prompt
 *  hook. Empty when the ledger is missing — see `turnsFrom` for why that matters. */
function readApprovedHashes() {
  try {
    const j = JSON.parse(fs.readFileSync(APPROVED_FILE, "utf8"));
    if (Array.isArray(j?.hashes)) return new Set(j.hashes.filter((h) => typeof h === "string"));
  } catch {
    /* no approval history in this state dir */
  }
  return new Set();
}

function promptHash(text) {
  return createHash("sha256").update(String(text).trim(), "utf8").digest("hex").slice(0, 32);
}

/** Split the transcript into completed turns: [{ prompt, response, unchecked }].
 *  A turn is the messages preceding a `turn_ended` marker, since the previous one.
 *
 *  `unchecked` marks a turn containing a user message the PII gate never saw —
 *  Cursor skips `beforeSubmitPrompt` for a message queued while the agent is busy,
 *  so it reaches the model unexamined and unblockable. With an EMPTY ledger we
 *  cannot tell a bypass from "no history" (first install, cleared state, hooks
 *  added mid-session), so nothing is flagged: an audit that cries wolf on every
 *  historical turn would be worse than none. */
function turnsFrom(lines, approved) {
  const turns = [];
  let userParts = [];
  let assistantParts = [];
  let extraParts = []; // auto-attached file/selection content, scanned but never shown
  let unchecked = false;
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a partially-written trailing line while Cursor is still writing
    }
    if (o?.type === "turn_ended") {
      turns.push({
        prompt: userParts.join("\n\n").slice(0, MAX_TEXT),
        response: assistantParts.join("").slice(0, MAX_TEXT),
        scanExtra: extraParts.join("\n\n").slice(0, MAX_TEXT),
        unchecked,
      });
      userParts = [];
      assistantParts = [];
      extraParts = [];
      unchecked = false;
      continue;
    }
    const t = textOf(o);
    if (!t) continue;
    if (o.role === "user") {
      const typed = userMessage(t);
      if (typed) {
        userParts.push(typed);
        if (approved.size > 0 && !approved.has(promptHash(typed))) unchecked = true;
      }
      // Auto-attached files are never in the approval ledger by construction; the
      // gateway decides whether they carried PII (and flags the row) — here we only
      // forward the content to scan.
      const attached = attachmentsOf(t);
      if (attached) extraParts.push(attached);
    } else if (o.role === "assistant") assistantParts.push(t);
  }
  return turns;
}

/** Identity of a logged turn. Content-addressed so dedupe survives Cursor
 *  REWRITING the transcript: a long session gets compacted (summarized in place),
 *  which a positional counter cannot survive — it ends up ahead of the content and
 *  silently stops logging that session (found live 2026-07-28: 17 logged vs 6
 *  present). A hash, not the text: nothing readable is written to disk. */
function turnHash(turn) {
  return createHash("sha256")
    .update(`${turn.prompt}\u0000${turn.response}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Hashes of turns already logged for this transcript, so a re-fire (or a later
 *  event in the same session) never double-logs. Hashes only: no transcript text
 *  is ever written to disk. */
function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    log(`cursor-turn-log-hook: could not persist state (${e.message})`);
  }
}

const raw = await readStdin();
let ctx;
try {
  ctx = JSON.parse(raw);
  if (!ctx || typeof ctx !== "object") throw new Error("not an object");
} catch {
  done(); // nothing to log; never disturb the session
}

const transcriptPath = typeof ctx.transcript_path === "string" ? ctx.transcript_path : "";
if (!transcriptPath) done();

let lines;
try {
  lines = fs.readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
} catch (e) {
  log(`cursor-turn-log-hook: cannot read transcript (${e.message}) — skipping`);
  done();
}

const turns = turnsFrom(lines, readApprovedHashes());
const state = readState();
const record = state[transcriptPath];
/** @type {Set<string>} */
let known;
if (Array.isArray(record?.logged)) {
  known = new Set(record.logged.filter((h) => typeof h === "string"));
} else if (Number.isFinite(Number(record))) {
  // Migrate the legacy positional counter: the first N turns still present were
  // logged. After a compaction N can exceed the turns that remain, and marking
  // ALL of them logged would wedge this transcript forever (the hook fires
  // BECAUSE a turn just ended, so there is always at least one worth logging) —
  // hence the clamp to length-1, which leaves the newest turn loggable.
  known = new Set(
    turns.slice(0, Math.min(Number(record), Math.max(0, turns.length - 1))).map(turnHash),
  );
} else {
  known = new Set();
}
// No early return once we get here: even a run with nothing new must persist the
// migrated hash set, or the legacy counter is re-read and re-migrated forever.

const model =
  (typeof ctx.model === "string" && ctx.model) ||
  (typeof ctx.model_id === "string" && ctx.model_id) ||
  "cursor-agent";

for (const turn of turns) {
  const hash = turnHash(turn);
  if (known.has(hash)) continue; // already logged (or pre-compaction survivor)
  // Skip empty turns (e.g. a turn that produced only tool calls). An attachment,
  // though never shown, still counts as content worth auditing.
  if (!turn.prompt.trim() && !turn.response.trim() && !turn.scanExtra.trim()) {
    known.add(hash);
    continue;
  }
  try {
    // RAW text is sent over loopback so the gateway's live rules do the
    // redaction and the PII flag/counts are accurate; it stores redacted only.
    // `scanExtra` carries auto-attached file/selection content: the gateway scans
    // it for PII (and flags the row) but never stores or displays it.
    const { status, json } = await postJson("/log-turn", {
      prompt: turn.prompt,
      response: turn.response,
      scanExtra: turn.scanExtra || undefined,
      model,
      provider: "openai", // Cursor's API family; console labels the row "cursor"
      source: "cursor-agent",
      unchecked: turn.unchecked === true,
    });
    if (status !== 200) throw new Error(`status ${status}`);
    // Loud on stderr when PII reached the model unexamined: the gate could not
    // have stopped it, so the audit trail is the only signal an operator gets.
    // Two unblockable paths — a queued send (turn.unchecked) and an auto-attached
    // file/selection (turn.scanExtra) — both surface as piiDetected here.
    if ((turn.unchecked || turn.scanExtra) && json?.piiDetected) {
      log(
        "cursor-turn-log-hook: PII reached the model in a send the PII gate never saw " +
          "(a queued message or an auto-attached open/selected file — Cursor invokes no " +
          "block hook on either path); logged as an unchecked turn",
      );
    }
    known.add(hash);
  } catch (e) {
    log(`cursor-turn-log-hook: /log-turn failed (${e.message}) — will retry next turn`);
    break; // hash NOT recorded, so the turn is picked up on the next hook fire
  }
}

// Bounded: a transcript's history can't grow the state file without limit.
state[transcriptPath] = { logged: [...known].slice(-MAX_TURN_HASHES) };
writeState(state);
done();
