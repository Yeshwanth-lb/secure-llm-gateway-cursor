# Cursor Integration Plan — Getting the Gateway to Protect Cursor Like It Protects Claude Code

**Status:** ✅ BUILT (2026-07-13) — Phases J (translation shim) + K (block-hooks) shipped,
suite 87/87 green. Claude Code integration was already done; Cursor now has full
bidirectional redaction of chat/agent traffic.
**Audience:** written for a lead/mentor review — plain language first, technical detail after.
**Last updated:** 2026-07-13

---

## 0. As-built summary (read this first)

The design below (§2–§5) was written as options B vs C on **two endpoints**. During
implementation we found that breaks on Cursor: **Cursor exposes only ONE global
"Override OpenAI Base URL"**, so two gateway endpoints can never both be reached from a
single Cursor install. **What shipped instead: one shared endpoint, routed by model name.**

**Setup (per machine):** Cursor → Settings → Models → add a key → enable "Override OpenAI
Base URL" → `http://127.0.0.1:8000/openai`. Then in Cursor's model list:
- Name a custom model `claude-via-gateway` (or any `claude-*` id) → the gateway **translates
  to the Anthropic Messages API and runs Claude**, fully redacted both ways.
- Any other model (e.g. `gpt-4o`) → **passes through to OpenAI**, still redacted.

The request's `model` id is the switch (the user sets it, so it's deterministic). This
replaces the abandoned `/cursor` second-endpoint idea. Config knobs:
`ANTHROPIC_API_KEY` (server-side, never sent to the client), `CURSOR_TRANSLATE_MODELS`,
`CURSOR_MODEL_MAP`, `CURSOR_DEFAULT_MODEL`, `CURSOR_MAX_TOKENS`.

**What shipped:**
- **Phase J** — `src/openai-anthropic-shim.ts` (request/response/stream translation) wired
  into `src/proxy.ts`; model-name routing via `shouldTranslate()`; model-policy checks the
  RESOLVED Claude model (the §5.1 ordering fix); logs show provider `anthropic` for
  translated calls, exactly like Claude Code. `tests/phase-j.test.ts` (3/3).
- **Phase K** — `scripts/cursor-redact-hook.mjs` + `POST /detect` (loopback-gated, never
  logs raw text); block-if-PII on `beforeReadFile`/`beforeTabFileRead`/`beforeSubmitPrompt`,
  fail-closed; wired by `configure-cursor`. `tests/phase-k.test.ts` (3/3).

**Unchanged limitations** (§7 still holds): hooks can only *block*, not scrub, native
file/Tab/prompt surfaces; Apply-from-Chat is uncoverable. The rest of this doc is retained
as design history — where it says "two endpoints / `/cursor`", read "one `/openai`
endpoint, model-routed" per this section.

---

## 1. Recap — why Claude Code works today

Claude Code reads an environment variable, `ANTHROPIC_BASE_URL`. We set it to
`http://127.0.0.1:8000` (our local gateway). From that point on, **every** request
Claude Code makes goes to the gateway first — the developer can't opt out, forget, or
bypass it. The gateway redacts the body, forwards the clean version to Anthropic, and
redacts the response on the way back.

The key property is **forced routing**: one setting captures 100% of traffic. That's why
Claude Code is airtight.

```
Claude Code ──(ANTHROPIC_BASE_URL)──▶ Gateway ──redact──▶ api.anthropic.com
```

---



## 2. Why Cursor is harder

Cursor does **not** honor `ANTHROPIC_BASE_URL`. It has its own settings, and each of its
surfaces (chat, agent, file-reads, Tab autocomplete) behaves differently:

- Cursor **has** an "Override OpenAI Base URL" setting → works correctly for
OpenAI-compatible models.
- Cursor **does not have** an "Override Anthropic Base URL" → confirmed open gap on
Cursor's own forum, not a bug on our side. Setting the OpenAI override while using
Claude models breaks them with `422` errors.
- Cursor's **Tab autocomplete** and **Apply-from-Chat** always use Cursor's own backend
and **cannot** be redirected by any base-URL setting.

So there is no single "forced routing" knob for Claude-in-Cursor the way there is for
Claude Code. Coverage has to be assembled from **two different mechanisms** (proxy +
hooks), each covering a surface the other can't.

---



## 3. The two mechanisms available in Cursor



### Mechanism 1 — Base-URL proxy (redacts the model request body / conversation)

Point a Cursor model endpoint at the gateway so chat/agent completion traffic flows
through our redaction engine. Covers the **conversation body**. Cannot touch Tab, and
breaks on Claude unless we add a translation shim (see §4, Option C).

### Mechanism 2 — Cursor hooks (block-only for native surfaces; rewrite only for MCP)

Cursor's hooks system (`~/.cursor/hooks.json`, already present in this project) runs a
local script on lifecycle events. **Pre-hooks** fire before an action; **post-hooks**
after. **Verified against Cursor's live docs (cursor.com/docs/hooks, 2026-07-13):**


| Hook                 | Output fields                                   | Can it **rewrite/redact**?                                    | Covers                          |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------------- | ------------------------------- |
| `beforeSubmitPrompt` | `continue`, `user_message`                      | ❌ **block only** — cannot rewrite typed text                  | typed prompt (block/allow)      |
| `beforeReadFile`     | `permission: allow/deny`, `user_message`        | ❌ **block only** — no content field                           | file reads (block/allow)        |
| `beforeTabFileRead`  | `permission: allow/deny`                        | ❌ **block only**                                              | Tab file reads (block/allow)    |
| `beforeMCPExecution` | `permission: allow/deny`                        | ❌ **block only** — MCP-specific gate                          | MCP calls (block/allow)         |
| `preToolUse`         | `permission`, `updated_input`                   | ✅ rewrite tool **input** — **generic** (Shell/Read/Write/MCP) | any tool call's input           |
| `postToolUse`        | `updated_mcp_tool_output`, `additional_context` | ✅ rewrite tool **output** — **MCP output only**               | MCP tool output                 |
| `afterFileEdit`      | (none documented)                               | ❌ observational                                               | auditing                        |


**Note on `preToolUse` vs `postToolUse` scope (don't conflate them):**
- `preToolUse` is a **generic** hook — it fires before *any* tool (Shell, Read, Write, MCP)
  and its `updated_input` can rewrite that tool's **input**. It is **not** MCP-only.
- `postToolUse` also fires generically, but its rewrite field `updated_mcp_tool_output`
  only affects **MCP tool output** — the field name is literal. So output-rewrite is
  MCP-scoped even though the hook itself isn't.
- `beforeMCPExecution` is the older MCP-specific gate — allow/deny only, no rewrite.

**CORRECTION (2026-07-13):** An earlier draft claimed `beforeReadFile` /
`beforeTabFileRead` could *rewrite* file content. **That is false** — verified against
Cursor's live docs. Those hooks are **allow/deny only**; there is no field to return
modified content. (The wrong claim traced to 9-month-old third-party blog posts written
just after Hooks launched in beta.) The only hooks that can rewrite are `preToolUse`
(`updated_input`, generic across tool types) and `postToolUse` (`updated_mcp_tool_output`,
MCP tool output only) — neither applies to Cursor's native Read/Tab file surfaces.

**What hooks can actually do for redaction:**

- **Block** a file read, Tab read, or prompt submission when it contains PII
(`permission: deny` / `continue: false`), with a `user_message` explaining why.
- **Rewrite** the output of an **MCP tool** via `postToolUse.updated_mcp_tool_output` —
e.g. if you build a custom MCP filesystem-read tool and the agent chooses to use it. But
you **cannot force** the agent to prefer a custom MCP reader over its built-in Read tool,
so this is "nice if the agent uses it," not a guarantee.

**Consequence:** the only mechanism that *scrubs* (rather than blocks) real Cursor traffic
is the **base-URL proxy** (Mechanism 1). Hooks are a **blunt block-or-allow gate** on
native file/Tab/prompt surfaces. Blocking file reads that contain PII can be disruptive if
the codebase mixes real data into files the agent legitimately needs (test fixtures, logs,
sample CSVs) — flag this before committing to it.

---



## 4. The options (build order, least to most effort)



### Option A — Monitoring only (what's configured now)

Cursor has the `secure-gateway` MCP tool (`get_traffic_logs`) + a fail-closed session
hook. **No redaction of real traffic.**

- Effort: done · Protection: inspection only · Verdict: baseline, not a solution



### Option B — Base-URL proxy via OpenAI-compatible models (works today, no code)

Point Cursor's "Override OpenAI Base URL" at `http://127.0.0.1:8000/openai`. The gateway
already has the `/openai` route (`src/routing.ts`, `OPENAI_PATHS`) and redaction is
body-text based, so it already redacts + forwards to `api.openai.com`.

- **Setup:** Cursor → Settings → Models → add OpenAI key → enable "Override OpenAI Base
URL" → `http://127.0.0.1:8000/openai` → pick a GPT model.
- Effort: ~5 min, zero code · Protection: **full auto** for chat/completions
- Cost: **Cursor uses GPT, not Claude.** Tab still bypasses.
- Verdict: fastest real protection **if** GPT-in-Cursor is acceptable.



### Option C — OpenAI↔Anthropic translation shim (base-URL proxy, keeps Claude)

Cursor uses the working OpenAI override, but the gateway translates the request into
Anthropic format, redacts it, sends it to Claude, and translates the response back into
OpenAI format. Cursor never knows the difference.

```
Cursor ──(OpenAI override)──▶ Gateway ─┐
                                        ├─ translate OpenAI→Anthropic shape
                                        ├─ redact (existing engine, unchanged)
                                        ├─ forward to api.anthropic.com
                                        ├─ redact response
                                        └─ translate Anthropic→OpenAI shape ──▶ Cursor
```

- Effort: one focused phase (see §5) · Protection: **full auto** + keeps Claude
- Cost: Tab still bypasses (needs Mechanism 2)
- Verdict: the only base-URL path to Claude parity.



### Option D — Block-if-PII gate via hooks (blunt safety net, NOT scrubbing)

Use `beforeReadFile`, `beforeTabFileRead`, and `beforeSubmitPrompt` to **block** (not
rewrite) any read/prompt that contains PII, with a `user_message` telling the developer to
remove it. Optionally build a custom MCP filesystem-read tool whose output is scrubbed via
`postToolUse.updated_mcp_tool_output` — but the agent can't be forced to use it over the
built-in Read tool, so treat that as best-effort only.

- Effort: low-moderate (reuse redaction engine to *detect*, then deny)
- Protection: **block-only** on files/Tab/prompts; **no silent scrubbing** of native reads
- Cost: blocking legitimate files with embedded data can disrupt the agent's work
- Verdict: a coarse safety net that complements B/C — it stops leaks by refusing, not by
cleaning. Set expectations accordingly.



### Recommended: **Hybrid = C (or B) + a scoped D**

- Chat/agent conversation body → base-URL proxy (Option C to keep Claude, or B for GPT).
**This is the only part that actually scrubs traffic.**
- Typed prompts with secrets → `beforeSubmitPrompt` block-and-warn.
- File/Tab reads → `beforeReadFile` / `beforeTabFileRead` block-if-PII **only if** the
team accepts occasional refused reads; otherwise skip to avoid disruption.
This is the closest achievable parity with Claude Code, given Cursor's constraints — but be
clear with the lead that Cursor parity is **weaker** than Claude Code: only the proxy path
scrubs; the rest can merely block.

---



## 5. Implementation breakdown

The redaction engine, routing, logging, streaming, and MCP server are **all reusable
as-is.** New work is thin. Zero new dependencies (pure JSON reshaping + reusing the
existing regex engine), consistent with the project's hard constraints.

### 5.1 Option C — translation shim

New module `src/openai-anthropic-shim.ts`, two pure functions (unit-testable):

- `openaiRequestToAnthropic(body)` — OpenAI chat-completions JSON → Anthropic Messages
JSON (map `messages[]`, roles, `model` alias, `max_tokens`, `temperature`, `stream`,
tool/function-call fields).
- `anthropicResponseToOpenAI(body, streaming)` — Anthropic response (single-JSON **and**
SSE stream) → OpenAI `chat.completion` / `chat.completion.chunk` shape.

Wiring:

- Route tier / flag: dedicated prefix (proposal `/cursor`, or `/openai` +
`x-translate: anthropic` header) marks a request for translation.
- In `src/proxy.ts`: run `openaiRequestToAnthropic` **before** the inbound scrub;
`anthropicResponseToOpenAI` **after** the response scrub. **Redaction is untouched** —
it runs on whatever body text is present.
- Streaming: `src/stream-redactor.ts` already handles Anthropic SSE; the response
translator re-frames redacted output as OpenAI SSE chunks.
- Model-name map (env-configurable): `{ "gpt-4o": "claude-sonnet-5", ... }`.
- Auth swap: replace Cursor's `Authorization: Bearer <openai-key>` with server-side
Anthropic `x-api-key` + `anthropic-version`. **Security win:** the real Anthropic key
never touches the client.

> **⚠️ Model-policy ordering bug — MUST fix as part of this shim.**
> Today `src/proxy.ts` extracts the model from the **raw** request body
> (`extractModel(...)`, ~line 169) and immediately runs `isModelBlocked(model)`
> (~line 205) **before** any translation. If the shim maps `gpt-4o → claude-sonnet-5`
> *after* that check, a Claude model that's blocked in Model Policy stays reachable under
> its GPT alias — the blocklist checks `gpt-4o`, sees it's allowed, and forwards a
> `claude-sonnet-5` request anyway. **Fix:** apply the model-name mapping *before* the
> `isModelBlocked` check (translate first, then policy-check the resolved real model), or
> re-run the policy check on the post-translation model. Add a Phase-J failure test:
> block `claude-sonnet-5` in policy, send a `gpt-4o` request through the shim, assert it's
> rejected — not forwarded.



### 5.2 Option D — hook-based block-if-PII gate

New script `scripts/cursor-redact-hook.mjs` (or extend `cursor-gateway-hook.mjs`):

- Reads the hook JSON on stdin, extracts file/prompt content, runs it through the
**existing redaction engine** (import from `src/redaction.ts`) purely to **detect** PII.
- If PII found: return `permission: "deny"` (reads) / `continue: false` (prompt) plus a
`user_message` naming what to remove. If clean: allow. **No content rewrite** — Cursor's
native read/prompt hooks do not support it (verified §3).
- Wire in `~/.cursor/hooks.json`: `beforeReadFile`, `beforeTabFileRead`,
`beforeSubmitPrompt`, all `failClosed: true` so a crashed hook denies rather than leaks.
- Optional MCP-scrub path: a custom MCP filesystem-read tool + `postToolUse`
`updated_mcp_tool_output` rewrite — best-effort only (agent may use built-in Read
instead).
- Extend `scripts/gateway-service.mjs configure-cursor` to write these entries.



### 5.3 Client config automation

Extend `configure-cursor` to (optionally) write Cursor model settings, mirroring
`configure-claude`. **Caveat:** some Cursor model settings live in its SQLite/UI state,
not a plain JSON file — verify what Cursor persists to disk before promising full
automation; this step may be partly manual with clear instructions.

---



## 6. Testing plan (matches the project's phase-gate TDD rule)

Add **Phase J — Cursor/OpenAI shim** and **Phase K — hook redaction**, each with the
mandatory happy/failure/edge e2e trio. Reuse the existing fake-upstream harness. Full
suite must stay green (currently 81/81).

**Phase J (shim):**

- Happy: OpenAI request w/ PII → translated to Anthropic → redacted → fake upstream
Messages response → translated back → valid redacted OpenAI response.
- Failure: malformed OpenAI body (no `messages`) → clean `400`, no crash, no leak, logged.
- Edge: streaming — Anthropic SSE with PII split across chunk boundaries → redacted →
re-framed as OpenAI SSE → nothing dropped, valid framing both ways.

**Phase K (hooks — block-if-PII):**

- Happy: `beforeReadFile` payload for a file containing PII → hook returns
`permission: "deny"` + a `user_message`; a clean file → `permission: "allow"`.
- Failure: hook receives malformed stdin → exits non-zero, `failClosed` denies the read.
- Edge: `beforeSubmitPrompt` with an API key in the typed prompt → `continue: false` +
clear `user_message`; a clean prompt → `continue: true`.
(No test asserts content rewrite — the API doesn't support it on these hooks.)

---



## 7. Honest limitations (say these in the meeting)

1. **Cursor hooks cannot scrub native reads/prompts** — verified against live docs.
  `beforeReadFile`, `beforeTabFileRead`, `beforeSubmitPrompt` are **block-or-allow only**.
   So the hook layer stops leaks by *refusing* content, not by *cleaning* it. Only the
   base-URL proxy actually scrubs.
2. **Blocking can be disruptive** — denying every file read that contains PII may refuse
  files the agent legitimately needs (test data, logs, CSVs). Scope carefully.
3. **MCP-only rewrite** — `postToolUse.updated_mcp_tool_output` can rewrite output, but
  only for MCP tools, and the agent can't be forced to prefer a custom MCP reader over its
   built-in Read tool. Best-effort, not a guarantee.
4. **Apply-from-Chat** uses Cursor's own backend — not coverable by proxy or hooks.
5. **Not "forced" like Claude Code** — a user could disable the override or hooks in
  Cursor settings. The session hook (fail-closed) can detect/warn but can't hard-lock it.
6. **Cursor hooks are beta** — output contract has shifted before; re-verify against
  `cursor.com/docs/hooks` after Cursor upgrades.
7. **Model fidelity (Option C)** — Cursor's UI shows a GPT name while Claude answers.
  Cosmetic, worth flagging to users.
8. **`@`-mention attachments bypassed the gate (found + fixed 2026-07-27)** — see §7.1.
9. **Queued messages bypass the prompt gate entirely, and this is UNFIXABLE from a hook
  (found live 2026-07-27)** — a message typed while the agent is busy is delivered without
   `beforeSubmitPrompt` ever being invoked. Not a deny we can win: there is no call at all.
   Only auditable after the fact — see §7.3.

---

### 7.3 The queued-message bypass (found live 2026-07-27, NOT fixable — audited instead)

**The hole.** Sending a prompt from the composer while the agent is idle works exactly as
designed: the hook fires, PII is detected, the send is denied, and the message never enters
the conversation (verified — the denied text appears nowhere in the transcript). But a
message **queued while the agent is busy** is delivered to the model with **no hook
invocation at all**. Not an allow, not a deny — the gate is never asked.

Proof from `prompt-hook-shape.log`, which records every invocation with its decision:

```
11:42:37  beforeSubmitPrompt  clean  ALLOW    <- "run the full test suite"
                                              <- queued: "my email is <addr>"  (NO ENTRY)
                                              <- queued: "did it work"         (NO ENTRY)
11:46:50  beforeSubmitPrompt  clean  ALLOW    <- next composer send
```

The invocation count did not move while two queued messages were delivered, one carrying a
real address. Cursor's own UI showed them as "2 Queued" at that moment.

**Why no hook can fix it.** There is no interception point on the drain path. No other
Cursor hook carries prompt text: `sessionStart` and `beforeMCPExecution` don't see prompts,
`preToolUse`/`postToolUse` cover tool payloads, and `stop` fires after the model already
answered. A queued send is committed to the conversation before any code of ours runs.

**A related, distinct failure.** Even when the hook DOES fire and denies, a message already
committed to the conversation is delivered anyway alongside the next approved send. The
prompt hook scans pending transcript messages to refuse *subsequent* sends in that state
(§7.1's mechanism, extended), but that is damage limitation after the fact, not prevention.
Note the transcript does **not** contain queued messages while they sit in the queue — it is
written on delivery — so the pending scan is blind to the queue itself.

**What we built instead: an audit trail (Phase N).** Prevention being impossible, the goal
becomes making the bypass visible rather than silent:

- `cursor-redact-hook.mjs` records a **SHA-256 hash** of every prompt it approves
 (`cursor-approved-prompts.json`, ring-capped at 500). Hashes only — no prompt text on disk,
 preserving the never-persist-raw-PII invariant.
- `cursor-turn-log-hook.mjs` hashes each delivered user message and flags a turn containing
 one with no matching hash: `unchecked: true` on the `/log-turn` call.
- `LogEntry.unchecked` (optional, additive — same shape as `blocked`) renders as an
 **`unchecked` pill** in the Inspector, red when the row also has PII. **`unchecked` +
 `piiDetected` is a confirmed leak**, and the hook writes a loud stderr line for it.
- **An empty ledger flags nothing.** On first install, cleared state, or hooks added
 mid-session we cannot distinguish a bypass from missing history, and an audit that cries
 wolf on every historical turn is worse than no audit.

**Say this plainly in the meeting:** Cursor prompt coverage is *block-on-composer-send,
audit-on-queue*. The queue path is a real, demonstrated leak that Cursor's hook API gives us
no way to close. If that is unacceptable, the only real fix is upstream (Cursor must invoke
`beforeSubmitPrompt` on the drain path) — worth filing.

---

### 7.2 Seeing Cursor chat in the Traffic Inspector (Phase M, 2026-07-27)

Limitation #1 above says the hook layer only refuses content — that remains true for
*enforcement*, but **visibility** is now solved. Cursor chat never reaches the gateway, so
the inspector could only show counts-only `HOOK` rows: no user prompt, no assistant output.

The fix mirrors the Gemini extension's `/log-turn` design, using a source we already had:
**Cursor writes the whole conversation to disk itself**, and passes the path to every hook
as `transcript_path`. Format (verified live, Cursor 2.1.207):

```
{"role":"user","message":{"content":[{"type":"text","text":...}]}}
{"role":"assistant","message":{"content":[{"type":"text"|"tool_use",...}]}}
{"type":"turn_ended","status":"success"}
```

`scripts/cursor-turn-log-hook.mjs` runs on `stop`, reads turns added since its last run,
and POSTs them to `/log-turn`, which redacts server-side and stores redacted text only.

Design points worth keeping:

- **Fail-OPEN, not fail-closed** (the one hook here that is). It gates nothing; dropping a
 log line leaks nothing, whereas a logging bug that blocks a session would be intolerable.
 A failed POST leaves the counter untouched so the turn is retried on the next fire.
- **Dedupe is counts-only** (`cursor-turnlog-state.json`: transcript path → turns logged).
 No transcript text is ever written to disk by the hook.
- **`Provider` is a frozen contract**, so Cursor turns store as `openai` (its API family,
 the same choice the tool-scrub audit makes) and the console labels `cursor-*` rows
 "cursor" for display.
- **The envelope is stripped.** Cursor wraps the typed message in `<user_query>`,
 `<timestamp>`, attachment and open-file blocks; the row shows what the user typed, the
 same way the Claude clean view strips Claude Code's boilerplate.
- **Tool-only turns are skipped** (already covered by the preToolUse/postToolUse scrub),
 and an unfinished turn is not logged until its `turn_ended` marker appears.

Live-verified: 7 real turns rendered with prompt + assistant output.

---

### 7.1 The `@`-mention attachment bypass (found live 2026-07-27, fixed)

Attaching a file with `@name (1-6)` inlined its contents into the request while
**both** hooks stayed silent, so raw PII reached the model. Confirmed live: a file the
`beforeReadFile` hook had just blocked was delivered in full one message later via `@`.

Why neither hook fired, from a live payload capture (`prompt-hook-shape.log`):

- **`beforeReadFile` never fires.** Cursor inlines the attachment itself; no agent file
 read happens, so there is nothing to gate.
- **`beforeSubmitPrompt` gets no content.** Its payload holds only `prompt` (the literal
 mention text, e.g. 26 chars for `@pii-block-test.txt (1-6)`). The `attachments` array
 carries **only `type:"rule"` path refs** (`CLAUDE.md`, `AGENTS.md`) — it never contains
 the mentioned file, and no field carries file content.

**Fix:** `scripts/cursor-redact-hook.mjs` now resolves `@`-tokens out of `ctx.prompt`
against `ctx.workspace_roots`, reads those files from disk, and scans each through
`/detect` — the content `beforeReadFile` would have seen. Unresolvable tokens (`@Web`,
`@Symbol`, missing files) are skipped; resolution stays inside a workspace root.
Regression tests in `tests/phase-k.test.ts`.

**The false-positive trap (do not "fix" this by scanning the whole payload).** Cursor
stamps its own **`user_email`** on every prompt — plus a `transcript_path` containing it.
Per-field capture showed every field clean except `user_email: PII {"EMAIL":1}`. A
whole-stdin scan would therefore deny **every message the user ever sends**. Only the
prompt text and files it resolves to may be scanned; a test guards this.

**Residual gap:** a mention scans the *whole* referenced file (stricter than the
attached line range — safe direction). If a way exists to attach content with **no**
`@`-token in the prompt, the payload carries no handle at all and that variant stays
uncovered. Re-run the capture (`touch ~/.secure-llm-gateway/hook-capture`) after a
Cursor upgrade to re-check the payload shape.

---



## 8. Recommendation & the decision needed

- **If GPT-in-Cursor is acceptable:** ship **Option B** now (5 min, zero code), then add
**Option D** hooks for file/Tab coverage.
- **If Claude-in-Cursor is required:** build **Option C** (translation shim) + **Option
D** hooks. Two contained phases, reusing the entire existing redaction/logging/streaming
stack, zero new dependencies.

**Decision needed from lead:** GPT acceptable in Cursor (B+D), or is Claude a hard
requirement (C+D)?

---



## 9. One-paragraph summary for the meeting

> Claude Code is fully protected because it lets us force all traffic through the gateway
> with one setting. Cursor doesn't offer that for Claude — a known gap on Cursor's side.
> The one mechanism that actually *scrubs* Cursor's traffic is a base-URL proxy for the
> chat conversation: the quick version routes Cursor through GPT and works today; the
> proper version is a small translation layer that keeps Claude, fully redacted. Cursor's
> hooks can add a coarser safety net on the surfaces the proxy can't reach — file reads,
> Tab autocomplete, and typed prompts get **blocked when they contain PII, rather than
> cleaned and let through** — because per Cursor's live docs those hooks can only block
> content, not rewrite it. So Cursor parity is close but genuinely weaker than Claude
> Code: the proxy cleans, the hooks only refuse. Apply-from-Chat and forced-on enforcement
> remain out of reach on Cursor's side.

