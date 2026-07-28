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
import path from "node:path";
import { createHash } from "node:crypto";
import { postJson, BASE_URL, STATE_DIR, log } from "./lib.mjs";

const MAX_STDIN = 512 * 1024;
const MAX_SCAN = 256 * 1024; // cap the text we scan (matches gateway snapshot budget)

// --- approval ledger (feeds the queue-bypass audit, Phase N) -----------------
// Cursor does NOT call this hook for a message queued while the agent is busy
// (proved live 2026-07-27: a queued prompt reached the model with no invocation),
// so that path cannot be blocked here. Record a HASH of every prompt we DO
// approve; the stop hook then flags a delivered message with no matching hash as
// having bypassed the gate. Hashes only — a prompt's text is never written here.
const APPROVED_FILE = path.join(STATE_DIR, "cursor-approved-prompts.json");
const APPROVED_CAP = 500; // ring: bounded file, plenty for one session's history

/** Stable digest of a prompt. Trimmed so the composer's text and the transcript's
 *  `<user_query>` body (which Cursor trims) produce the same hash. */
function promptHash(text) {
  return createHash("sha256").update(String(text).trim(), "utf8").digest("hex").slice(0, 32);
}

function rememberApproved(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return;
  try {
    let hashes = [];
    try {
      const j = JSON.parse(fs.readFileSync(APPROVED_FILE, "utf8"));
      if (Array.isArray(j?.hashes)) hashes = j.hashes.filter((h) => typeof h === "string");
    } catch {
      /* first approval in this state dir */
    }
    const h = promptHash(trimmed);
    if (!hashes.includes(h)) hashes.push(h);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      APPROVED_FILE,
      JSON.stringify({ hashes: hashes.slice(-APPROVED_CAP), updated: new Date().toISOString() }),
    );
  } catch (e) {
    // Best-effort: a missing approval only costs a false "unchecked" flag on an
    // audit row. It must never affect the allow/deny decision.
    log(`cursor-redact-hook: could not record approval (${e.message})`);
  }
}

// Opt-in schema capture: `touch ~/.secure-llm-gateway/hook-capture` (or
// CURSOR_HOOK_CAPTURE=1) to record what Cursor actually sends this hook. Needed
// to answer whether @-mention ATTACHMENT content reaches beforeSubmitPrompt — if
// it does, we can scan it; if not, attachments are an unclosable bypass.
// Unlike the Phase L capture this writes NO raw payload: only key paths, value
// types and string LENGTHS, plus a counts-only PII verdict for the whole stdin.
const CAPTURE_FLAG = path.join(STATE_DIR, "hook-capture");
const CAPTURE_LOG = path.join(STATE_DIR, "prompt-hook-shape.log");

/** Structural summary of a payload: key paths + types + string lengths, no values. */
function describeShape(v, prefix = "", out = []) {
  if (v === null || v === undefined) {
    out.push(`${prefix}: ${v === null ? "null" : "undefined"}`);
  } else if (Array.isArray(v)) {
    out.push(`${prefix}: array[${v.length}]`);
    v.slice(0, 8).forEach((el, i) => describeShape(el, `${prefix}[${i}]`, out));
  } else if (typeof v === "object") {
    if (prefix) out.push(`${prefix}: object`);
    for (const k of Object.keys(v)) describeShape(v[k], prefix ? `${prefix}.${k}` : k, out);
  } else if (typeof v === "string") {
    out.push(`${prefix}: string(${v.length})`);
  } else {
    out.push(`${prefix}: ${typeof v}`);
  }
  return out;
}

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

const CAPTURE_ON = process.env.CURSOR_HOOK_CAPTURE === "1" || fs.existsSync(CAPTURE_FLAG);

/** Record the decision alongside the captured payload shape, so the log answers
 *  "was this prompt seen, and what did we do about it?" on its own. */
function captureDecision(event, deny, message) {
  if (!CAPTURE_ON) return;
  try {
    fs.appendFileSync(
      CAPTURE_LOG,
      `decision[${new Date().toISOString()} ${event || "(no event)"}]: ${deny ? "DENY" : "ALLOW"}` +
        (deny && message ? ` — ${message.slice(0, 120)}` : "") +
        "\n\n",
    );
  } catch {
    /* capture is best-effort */
  }
}

/** Record what was scanned — labels and lengths only, never the text — so the log
 *  distinguishes "no pending messages" from "the pending scan never ran". */
function captureScan(targets, transcriptPath) {
  if (!CAPTURE_ON) return;
  try {
    const pending = targets.filter((t) => t.pending).length;
    fs.appendFileSync(
      CAPTURE_LOG,
      `pending[${transcriptPath ? "transcript_path present" : "NO transcript_path"}]: ` +
        `${pending} pending, ${targets.length} target(s) — ` +
        (targets.map((t) => `${t.label} (${t.text.length}c)`).join(", ") || "nothing to scan") +
        "\n",
    );
  } catch {
    /* capture is best-effort */
  }
}

/** Emit a decision for the given event and exit. `deny` chooses the block shape. */
function decide(event, deny, message) {
  captureDecision(event, deny, message);
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

// --- opt-in schema capture (shape only, never raw) -------------------------
if (CAPTURE_ON) {
  // Does the payload carry PII ANYWHERE (not just in ctx.prompt)? A "yes" here
  // with an allow decision below is the signature of a bypass we CAN close.
  // Attributed PER TOP-LEVEL FIELD, because Cursor ships its own `user_email`
  // on every prompt — a whole-payload scan would match that and block forever.
  const verdictFor = async (value) => {
    try {
      const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
      const { status, json } = await postJson("/detect", { text: text.slice(0, MAX_SCAN) });
      if (status !== 200 || !json) return "?";
      return json.piiDetected ? `PII ${JSON.stringify(json.matched)}` : "clean";
    } catch {
      return "? (gateway unreachable)";
    }
  };
  const fieldLines = [];
  for (const k of Object.keys(ctx)) fieldLines.push(`  ${k}: ${await verdictFor(ctx[k])}`);
  // Attachment PATHS ONLY — needed to judge whether the hook could resolve and
  // scan the referenced files itself. Values are echoed only for path/type-like
  // keys; anything else is reduced to a length so a `content` field (should one
  // ever appear) can never write raw PII to disk.
  const PATH_KEYS = new Set(["type", "file_path", "path", "uri", "url", "name"]);
  const describeAttachment = (a) => {
    if (!a || typeof a !== "object") return typeof a === "string" ? `string(${a.length})` : String(a);
    return Object.keys(a)
      .map((k) => {
        const v = a[k];
        if (typeof v === "string") {
          return PATH_KEYS.has(k) ? `${k}=${JSON.stringify(v)}` : `${k}=string(${v.length})`;
        }
        return `${k}=${JSON.stringify(v)}`;
      })
      .join(" ");
  };
  const attachLines = Array.isArray(ctx.attachments)
    ? ctx.attachments.map((a, i) => `  [${i}] ${describeAttachment(a)}`)
    : ["  (none)"];
  try {
    const report = [
      `=== ${new Date().toISOString()} ${event || "(no event)"} ===`,
      `stdin bytes: ${raw.length}`,
      `ctx.prompt length: ${typeof ctx.prompt === "string" ? ctx.prompt.length : "(absent)"}`,
      "per-field PII verdict:",
      ...fieldLines,
      "attachments (verbatim — paths only, these carry no content field):",
      ...attachLines,
      "shape:",
      ...describeShape(ctx).map((l) => "  " + l),
      "",
    ].join("\n");
    fs.appendFileSync(CAPTURE_LOG, report + "\n");
    log(`cursor-redact-hook: captured ${event} shape -> ${CAPTURE_LOG}`);
  } catch {
    /* capture is best-effort */
  }
}

// --- @-mention resolution (the attachment bypass, found 2026-07-27) ---------
// Attaching a file/selection with `@name (1-6)` inlines its content into the
// request but produces NO beforeReadFile event, and this hook is handed only the
// mention TEXT — `attachments` carries `type:"rule"` path refs, never the
// mentioned file. So the prompt hook resolves @-tokens itself and scans them
// from disk, the same content beforeReadFile would have seen.
//
// Only prompt text and files it resolves to are ever scanned. The rest of the
// payload is deliberately untouched: Cursor stamps its own `user_email` (and a
// `transcript_path` containing it) on EVERY prompt, so a whole-payload scan
// would deny every message the user sends.
const MAX_MENTIONS = 20;

/** Realpath or null (unresolvable paths are simply not scannable). */
function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Resolve `@token`s in the prompt to readable files inside a workspace root.
 *  Returns Map<realPath, labelAsTyped>. Unresolvable tokens (@Web, @Symbol, a
 *  missing file) are skipped — they cannot carry content, so they cannot leak. */
function resolveMentions(prompt, roots) {
  const found = new Map();
  const realRoots = roots.map(realOrNull).filter(Boolean);
  for (const m of prompt.matchAll(/@([^\s@]+)/g)) {
    if (found.size >= MAX_MENTIONS) break;
    const label = m[1].replace(/[),.;:!?'"\]]+$/, ""); // trailing punctuation isn't part of the path
    if (!label) continue;
    const candidates = path.isAbsolute(label)
      ? [label]
      : realRoots.map((r) => path.resolve(r, label));
    for (const c of candidates) {
      const real = realOrNull(c);
      if (!real) continue;
      let st;
      try {
        st = fs.statSync(real);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      // Stay inside the workspace — never wander the filesystem on a stray token.
      const inRoot = realRoots.some((r) => real === r || real.startsWith(r + path.sep));
      if (!inRoot) continue;
      found.set(real, label);
      break;
    }
  }
  return found;
}

// --- pending-message bypass (found live 2026-07-27) -------------------------
// A DENY stops that one send but does NOT remove the message from the chat:
// Cursor keeps it and delivers it alongside the NEXT approved prompt, which the
// hook never re-checks (`prompt` only ever holds the newly typed text). Proved
// live — a denied email arrived at the model one message later.
//
// Pending messages are visible in Cursor's own transcript as `role:"user"`
// entries after the last `turn_ended` marker. Scan those too, so we refuse to
// send while a blocked message is still sitting in the conversation.
function pendingUserMessages(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return []; // unreadable transcript -> nothing extra to scan
  }
  let lastEnd = -1;
  lines.forEach((l, i) => {
    try {
      if (JSON.parse(l)?.type === "turn_ended") lastEnd = i;
    } catch {
      /* partially-written line */
    }
  });
  const out = [];
  for (const line of lines.slice(lastEnd + 1)) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.role !== "user") continue;
    const c = o.message?.content;
    const text = Array.isArray(c)
      ? c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("")
      : typeof c === "string"
        ? c
        : "";
    // Only the typed message, not Cursor's context envelope (which carries the
    // account `user_email` and would otherwise deny every prompt forever).
    const queries = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((m) => m[1].trim());
    for (const q of queries) if (q) out.push(q);
  }
  return out;
}

// --- build the list of texts to scan for this event -------------------------
/** @type {{label: string, text: string, pending?: boolean}[]} */
const targets = [];
/** The text this send is submitting — recorded as approved only if we allow it. */
let submittedPrompt = "";
try {
  if (event === "beforeSubmitPrompt") {
    const prompt = typeof ctx.prompt === "string" ? ctx.prompt : "";
    submittedPrompt = prompt;
    if (prompt.trim() !== "") targets.push({ label: "your prompt", text: prompt });

    const roots = (Array.isArray(ctx.workspace_roots) ? ctx.workspace_roots : []).filter(
      (r) => typeof r === "string" && r,
    );
    for (const [real, label] of resolveMentions(prompt, roots.length ? roots : [process.cwd()])) {
      const content = fs.readFileSync(real, "utf8");
      if (content.includes("\u0000")) continue; // binary — not a text leak vector
      if (content.trim() !== "") targets.push({ label, text: content });
    }

    if (typeof ctx.transcript_path === "string" && ctx.transcript_path) {
      for (const pending of pendingUserMessages(ctx.transcript_path)) {
        if (pending === prompt.trim()) continue; // this same prompt, already queued
        targets.push({
          label: "an earlier message still pending in this chat",
          text: pending,
          pending: true,
        });
      }
    }
  } else {
    // beforeReadFile / beforeTabFileRead: prefer inlined content, else read disk.
    let text = "";
    if (typeof ctx.content === "string") {
      text = ctx.content;
    } else if (typeof ctx.file_path === "string" && ctx.file_path) {
      text = fs.readFileSync(ctx.file_path, "utf8");
    }
    if (text.trim() !== "") targets.push({ label: ctx.file_path || "this file", text });
  }
} catch (e) {
  log(`cursor-redact-hook: could not read content (${e.message}) — failing closed (deny)`);
  decide(event, true, "Could not verify file for PII; blocked by policy.");
}

captureScan(targets, typeof ctx.transcript_path === "string" ? ctx.transcript_path : "");

// Nothing to scan -> allow (an empty read/prompt can't leak).
if (targets.length === 0) decide(event, false);

// --- ask the gateway (live rules) whether any target contains PII ------------
for (const target of targets) {
  const text = target.text.length > MAX_SCAN ? target.text.slice(0, MAX_SCAN) : target.text;
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
    // A blocked message is NOT removed from the chat — it would be delivered with
    // this send — so the fix is to delete it, not to edit the current prompt.
    const advice = target.pending
      ? "Delete that message from the chat (or start a new chat) before continuing — blocking it did not remove it, so it would be sent along with this one."
      : "Remove or redact it before continuing (the gateway cannot silently scrub file reads or prompts — Cursor only allows block/allow here).";
    log(`cursor-redact-hook: blocked ${event} — detected ${types} in ${target.label}`);
    decide(event, true, `Blocked: detected ${types} in ${target.label}. ${advice}`);
  }
}

// Allowed, and every target was scanned: this prompt passed the gate. Record it
// so the stop hook can tell a gated send from one that skipped the gate entirely.
if (event === "beforeSubmitPrompt") rememberApproved(submittedPrompt);

decide(event, false);
