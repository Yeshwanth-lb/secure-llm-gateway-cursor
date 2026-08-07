# CHECKPOINT2_ACTION_GUARD.md — Action Guard (Checkpoint 2, draft)

> **Supersedes** the two earlier drafts `CHECKPOINT2_COMMAND_GUARD.md` and
> `CHECKPOINT3_OUTPUT_GUARD.md`. Those split one problem into two checkpoints; this
> merges them, because "a command the agent runs" and "code the agent writes" are two
> faces of the same thing — **guarding what the AI agent DOES, and forcing it safe.**
>
> Companion to `PROMPT_GUARD.md` (Checkpoint 1, shipped). Same gateway, same
> `securityLog`, same single-source-of-truth pattern, same zero-dep + dark-by-default
> rules. This is a starting doc for `phase/action-guard`, **not** shipped work. Sections
> marked **(OPEN)** need a decision or a live-probe before build. Hook contracts here were
> verified against the live Claude Code + Cursor docs on 2026-08-06 (sources at bottom).

---

## 1. What it is (one paragraph)

Prompt Guard (CK1) watches what the user **asks for**, before code exists, and steers the
model with injected guidance. **Action Guard (CK2)** watches what the agent actually
**does** — the shell commands it runs and the code it writes — and makes those safe. It has
**two enforcement modes**, chosen by whether the action can still be stopped:

- **Commands → PREVENT.** A shell command is caught *before* it runs, so the guard can
  **block or ask**. A missed destructive command is unrecoverable, so this path's intended
  posture is fail **CLOSED**.
- **Code → CORRECT.** A file edit is caught *after* it lands, so there's nothing left to
  block; instead the guard scans the file and, if it's unsafe, uses the turn-end hook to
  **tell the agent to regenerate it securely**, looping until clean or capped. This is
  exactly the mechanism Semgrep Guardian ships (validated below), minus its dependency.

Action Guard **never edits a command or a file itself**, and never silently "fixes"
anything — same non-negotiable as Prompt Guard never editing the user's message. It only
**allows, denies, asks, or asks-the-agent-to-redo.**

---

## 2. The mental model — one pipeline, three levers

Every agent action runs through **intercept → evaluate → enforce**. The only thing that
changes is *which lever is available*, and that depends on **when** you catch it:

| Stage caught | Lever | Posture | Guarantee (see §5) |
|---|---|---|---|
| Command **about to run** | **block / ask** | fail-closed | Strong on Claude Code; best-effort on Cursor |
| Code **just written** | **regenerate loop** (can't block — already on disk) | fail-safe | Bounded loop; never blocks work |
| Anything, always | **log to `securityLog`** | audit | **Airtight — always works, even when a block is dropped** |

**The audit row is the load-bearing guarantee.** No in-agent hook is a hard block (verified:
Cursor can ignore a `deny` in its sandbox; Claude Code runs the command if your hook
crashes). So Action Guard is **defense in depth**, not a single wall:

1. **Prevent** where the platform honors it (commands).
2. **Correct** where prevention is impossible (code).
3. **Audit always** — even a bypassed block leaves a visible row *within the turn*, so
   nothing dangerous happens "without our knowledge." That is the actual promise we can keep.

---

## 3. One rule brain, two evaluators (`src/action-rules.ts`)

Both surfaces and both modes call ONE evaluator — the same way both Prompt Guard surfaces
share one `analyze()`. A command string and a written file are just two inputs to it.

| | **Tier 1 — deterministic patterns** | **Tier 2 — LLM classifier** |
|---|---|---|
| What | Zero-dep regex/AST-lite rules in `src/`, same style as the PII engine | Reuse `classifyViaAnthropic` with a **code-scoped** system prompt |
| Catches | Textual shapes: `rm -rf`, `curl \| sh`, hardcoded secret, `eval(`, `md5`, obvious SQL concat | Semantic/structural bugs: missing auth, IDOR, "understand what the code does" cases |
| Cost | Instant, free, can't time out | Seconds, tokens; **gateway's own** `ANTHROPIC_API_KEY`, **Anthropic-only** |
| Category source | reuse `RiskCategory` from `src/guidance.ts` | same `RiskCategory` list |

**Both tiers run on every code scan, unconditionally — Tier 2 is NOT gated on Tier 1.**
Tier 1 is structurally blind to missing-auth/IDOR, so using it as a pre-filter would let
exactly the bugs Tier 2 exists for slip through whenever Tier 1 is clean. Run in parallel,
merge findings. (Commands only need Tier 1 — a closed, enumerable set; an LLM per command
is needless latency. Tier 2 on commands is a later option, not v1.)

### 3.1 Why NOT Semgrep (even though Guardian uses it)

Semgrep Guardian validated our **loop** (§7), but its **engine** is a Python binary with a
network-fetched rule corpus (`--config auto`). That breaks the project's #1 constraint —
CLAUDE.md §2: *"Dependencies: Zero… Zero supply-chain surface is a feature, not an
accident."* The admin-dashboard checkpoint already rejected a stack for violating §2; the
same bar applies here. Semgrep's real value is **AST pattern matching** (it matches code
*shapes*, language-aware, low false-positive) — we get the equivalent depth from the **LLM
Tier 2** reading the whole file, with zero dependency. So: copy Guardian's loop, replace its
AST engine with our Tier 2. *(If Semgrep's depth is ever deemed essential, it must be an
explicit, documented §2 exception: offline pinned rules, no `--config auto`, graceful skip
if the binary is absent — never a silent hard dep.)*

### 3.2 What we deliberately do NOT copy from Guardian — the on-demand MCP scan tool

Guardian is not purely reactive: besides the scan-after-edit hooks, it **exposes Semgrep as
a Cursor MCP tool** the agent can call on demand mid-task ("let me scan this before I say
I'm done"). **Action Guard does not build that surface** — it is hook-driven and reactive
only. This is a **deliberate choice, not an omission:** an MCP tool is more attack surface
and more to maintain, and it would front the Semgrep engine, inheriting the same zero-dep
problem (§3.1). The reactive hook loop already forces a re-scan before the turn can end, so
an on-demand call buys little here. Left out on purpose; revisit only if a real "scan
mid-task" need appears.

---

## 4. Verified per-platform hook contracts

The two enforcement modes map onto different hooks per platform. **These were verified
against live docs — the earlier drafts assumed contracts that don't hold.**

| Purpose | **Cursor** | **Claude Code** |
|---|---|---|
| Block a command | `beforeShellExecution` → `{permission:"allow"\|"deny"\|"ask"}` (or `preToolUse`, generic, already wired) | `PreToolUse` (matcher `"Bash"`) → `hookSpecificOutput.permissionDecision:"allow"\|"deny"\|"ask"\|"defer"`, **or `exit 2`** |
| Command string in stdin | `command` field | `tool_input.command` |
| Scan a written file | `afterFileEdit` (observational; gives `edits[]` old/new + `file_path`, **not** full content) | `PostToolUse` (matcher `"Edit\|Write"`; stdin `tool_input.file_path`) |
| Re-prompt at turn end | `stop` → `{followup_message}` (submitted as next user msg) | `Stop` → `{"decision":"block","reason":"…"}` or `exit 2` |
| Loop brake | `loop_count` in stdin; **hard cap 5 auto-followups**; per-hook `loop_limit` | **`stop_hook_active` bool in stdin — check FIRST**; hard cap **8** (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) |
| Fail-closed on hook error | set `failClosed:true` on the entry | **none — platform is fail-OPEN**; hook must itself `exit 2`/deny on any error |

### 4.1 The gotchas that shape the design (do not skip)

1. **Cursor may ignore a `deny`.** Known bugs: an allow-listed command overrides the hook's
   verdict, and the **sandboxed Agent shell ignores `ask`** (`"sandbox":true` in payload,
   command runs the same turn anyway). → **Prefer `deny` over `ask` on Cursor**, and treat
   Cursor command-blocking as *best-effort + always-logged*, not guaranteed.
2. **Claude Code fails OPEN on hook error.** Only `exit 2` blocks; `exit 1`/other ⇒ the
   command runs. There is **no `failClosed` flag**. → The Claude Code command hook MUST wrap
   everything in try/catch + self-timeout and **emit deny / `exit 2` on any error or
   gateway-unreachable** — never fall through to a natural nonzero exit.
3. **`afterFileEdit` / `PostToolUse` give the diff, not the file.** The hook has `file_path`;
   it must **read the file** to scan full current content (not just old/new strings).
4. **stdout hygiene (Cursor):** the `stop`/`afterFileEdit` hook must print **exactly one
   JSON object** to stdout, all diagnostics to stderr, and **`exit 0` even when it found
   problems** — a non-zero exit makes Cursor treat the hook as crashed and drop the
   `followup_message`.
5. **`ask` works on both** — so no "map ask→deny" flag is needed (the CK2 draft's flag is
   dropped). But given gotcha #1, `deny` is the safer default for hard-destructive commands;
   reserve `ask` for the `git_destructive` "confirm with a human" category.
6. **Loop caps differ (5 vs 8).** If you want a *uniform* limit, the script must count and
   stop itself below both platform caps; otherwise accept 5 on Cursor, 8 on Claude Code.
7. **`stop_hook_active` is CONFIRMED and MANDATORY — a correctness requirement, not an OPEN
   item.** Verified: the Claude Code `Stop` hook receives `stop_hook_active` (bool) in stdin,
   and the harness force-stops after **8** consecutive blocks (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).
   The 8-cap is a backstop, **not** your loop control. The check
   `if (stop_hook_active) exit 0` **must be the literal first line** of
   `claude-code-action-stop-hook.mjs`, before any scan or `/pending` call runs. Skipping it
   is not a minor bug: a stubborn false-positive finding will re-block every turn until the
   8-cap (or the token budget) is hit — a reported Claude Code issue had exactly this run a
   full session (~50 min) to the token cap with real billing impact. **First line, before
   the scanner. No exceptions.**

---

## 5. Mode A — Commands (PREVENT)

```
agent wants to run a command
      │
      ▼
Cursor beforeShellExecution / Claude Code PreToolUse(Bash)
      │  POST /action-guard/command  { command, surface }
      ▼
Tier-1 pattern match against action-rules.ts
      │
      ├─ destructive_fs / priv_escalation / remote_exec / infra_destructive ─► DENY + LOG
      ├─ git_destructive (force-push, reset --hard, clean -fdx, branch -D …) ─► ASK  + LOG
      └─ clean ──────────────────────────────────────────────────────────────► ALLOW (not logged)
```

- **Fail CLOSED, made real per §4.1:** endpoint returns `deny` on error; Claude Code hook
  self-denies on crash/timeout; Cursor entry `failClosed:true` (+ accept best-effort on
  sandbox/allow-list, always logged).
- `git_destructive` is its own `ask` category — force-push/hard-reset destroy *shared
  history*, a distinct risk shape from wiping a disk, and worth its own audit label.
  **(OPEN)** `git commit --amend` is only dangerous if already pushed (state, not visible in
  the string) — v1: treat all `--amend` as `ask`, accept false positives, revisit with data.

## 6. Mode B — Code (CORRECT / regenerate loop)

This is Guardian's mechanism, zero-dep:

```
file edit lands
      │
      ▼
afterFileEdit / PostToolUse  →  hook reads the file  →  POST /action-guard/scan
      │                                                      │
      │                                   Tier 1 + Tier 2 in parallel, findings merged
      │                                   appended to conversation_id accumulator
      ▼
agent believes it's done → stop / Stop hook
      │  (Claude Code: check stop_hook_active FIRST → if true, exit 0)
      │  GET /action-guard/pending?conversation_id=   (returns + CLEARS findings)
      ▼
   findings? ──no──► loop ends normally
      │yes
      ▼
   Cursor: {followup_message:"Regenerate securely: <findings>"}
   Claude Code: {"decision":"block","reason":"Regenerate securely: <findings>"}
      │
      ▼
   agent fixes → edits again → afterFileEdit/PostToolUse re-scans → back to stop → repeat,
   bounded by the platform cap (5 / 8) and/or a script-side GATEWAY_ACTION_GUARD_LOOP_LIMIT
```

- **Accumulator is required** because `stop` fires per-turn with no edited-file list (known
  platform gap), while `afterFileEdit` fires per-edit — so findings must accumulate per
  `conversation_id` and be read+cleared once at `stop`.
- **Never blocks or reverts the edit** — only ever adds a follow-up message.
- **(OPEN) cap-behavior when still dirty at the limit** — `GATEWAY_ACTION_GUARD_CAP_BEHAVIOR`:
  - `warn` (default, recommended v1): log an **unresolved** row surfaced *prominently* in the
    admin console, let the turn end. Doesn't block real work; risk = a vuln ships unless
    someone reads the log (mitigated by making the row loud, not buried).
  - `block`: end the turn in a visibly-failed state so a human must look. Safer against
    silent shipping; risk = blocking legit work on a stubborn false positive.
  Ship `warn`, revisit with real cap-hit data (same "honest default, tune later" approach as
  Prompt Guard's Tier-1 skip).

---

## 7. Decision endpoints (all loopback-gated)

| Method + path | Purpose | Failure mode |
|---|---|---|
| `POST /action-guard/command` | Classify a command (Tier 1). `{command, surface}` → `{permission, category, user_message, agent_message}` | **fail CLOSED** → `{permission:"deny"}` |
| `POST /action-guard/scan` | Scan a file (Tier 1‖Tier 2), append to accumulator. `{conversation_id, file_path, content, surface}` → `{findings:[{tier,category,message,line}]}` | log `kind:"action-guard-error"`, return empty findings — **never block** (there's nothing to block) and **never silently drop** |
| `GET /action-guard/pending?conversation_id=` | Return **and clear** the accumulator for that conversation | empty on error |

> **(OPEN) field-name casing.** Response uses snake_case (`user_message`), matching this
> repo's existing Cursor hooks. But `beforeShellExecution` type defs use **camelCase**
> (`userMessage`/`agentMessage`) and casing varies per hook/version. **Probe the live Cursor
> schema before coding**; the gateway can emit both casings defensively if inconclusive.

---

## 8. Logging (reuse `securityLog`)

Third `kind`: `"action-guard"`. Each row carries:
- `verb`: `"command"` | `"write"` (which mode).
- matched `category` (`RiskCategory`) + which tier flagged it + (for commands) the exact
  matched pattern — the match is deterministic and worth recording precisely for audit.
- for `write` rows: a `resolved` flag (cleared by a clean re-scan) vs shipped-unresolved at
  cap. This is the one genuinely new field vs CK1 (which is point-in-time, not a loop).
- **file path + line only — never full file contents** (duplicating the codebase into a ring
  buffer buys nothing).

Only `deny`/`ask`/finding decisions are logged (plain allows are noise — same as CK1). **On
Cursor, log the attempt even when the platform dropped the block** (§4.1 #1) — that dropped
block is exactly what a reviewer needs to see.

> Impl note: `SecurityLogEntry.surface` is currently `"claude-code"|"cursor-rules"|
> "cursor-hook"`. Add the `kind` discriminator (preferred) and/or widen `surface`. Leave
> `attachResponse` untouched — action-guard rows don't back-fill a model reply.

---

## 9. Configuration (all env-driven, dark by default)

| Env var | Default | Meaning |
|---|---|---|
| `GATEWAY_ACTION_GUARD` | *(off)* | `on` enables the guard. When off, **hooks are not wired** — commands and edits are ungated (dark-default must never brick shell/edit flows). |
| `GATEWAY_ACTION_GUARD_LOOP_LIMIT` | `5` | Script-side regenerate cap (keeps behavior uniform under the 5/8 platform caps). |
| `GATEWAY_ACTION_GUARD_CAP_BEHAVIOR` | `warn` | `warn` = §6 option (a), `block` = (b). Build-time decision, not runtime. |

Tier 2 reuses `GATEWAY_PROMPT_GUARD_MODEL` / `_TIMEOUT_MS` and the gateway's own
`ANTHROPIC_API_KEY` — same classifier engine, same knobs, no parallel config surface.

---

## 10. Files

**New:**
- `src/action-rules.ts` — categories + command patterns, single source of truth for both
  surfaces & modes; reuses `RiskCategory`.
- `src/action-scanner.ts` — Tier 1 (zero-dep patterns) + Tier 2 (reuse `classifyViaAnthropic`,
  code-scoped prompt), merges findings.
- `src/action-guard-store.ts` — per-`conversation_id` findings accumulator (in-memory, cleared on read).
- `scripts/cursor-command-guard-hook.mjs` — `beforeShellExecution` (or `preToolUse`).
- `scripts/cursor-action-scan-hook.mjs` — `afterFileEdit` (reads file, POST `/scan`).
- `scripts/cursor-action-stop-hook.mjs` — `stop` (GET `/pending`, emits `followup_message`).
- `scripts/claude-code-command-guard-hook.mjs` — `PreToolUse(Bash)`, **self-denies on error**.
- `scripts/claude-code-action-scan-hook.mjs` — `PostToolUse(Edit|Write)`.
- `scripts/claude-code-action-stop-hook.mjs` — `Stop`, **checks `stop_hook_active` first**.
- `tests/phase-action-guard.test.ts`.

**Modified:**
- `src/server.ts` — the three `/action-guard/*` endpoints.
- `src/config.ts` — `GATEWAY_ACTION_GUARD*` flags.
- `src/security-log.ts` — `kind:"action-guard"` + `verb` + `resolved`.
- `src/admin-console.ts` — Action Guard tab, unresolved rows surfaced prominently.
- `scripts/gateway-service.mjs` — `configure-cursor` wires the 3 Cursor hooks; add Claude
  Code `PreToolUse`/`PostToolUse`/`Stop` wiring for that surface.

---

## 11. Tests to write before "done"

- **Commands:** each category's patterns match; near-misses (`--force-with-lease`) do NOT
  match `git_destructive`; endpoint fails CLOSED (`deny`) on throw/malformed/timeout;
  **Claude Code hook self-denies on gateway-unreachable (asserts it does NOT exit 1).**
- **Code Tier split:** Tier 1 flags string-concat SQL; **Tier 2 flags a missing-auth route
  Tier 1 misses** — the test that proves "run independently" (§3) matters.
- **Accumulator:** two edits in one turn both land findings; `stop` reads+clears both; a
  second `stop` same turn returns empty.
- **Loop:** fixture dirty for 3 fake attempts, clean on the 4th → stops looping; cap-hit
  path matches the chosen §6 behavior; **Claude Code `stop_hook_active:true` ⇒ hook exits 0
  (no re-block).**
- **Scan failure** (classifier throws) logs `kind:"action-guard-error"`, not identical to
  "clean."
- **Live e2e (mirrors PROMPT_GUARD §13):** a denied command actually blocked in a live
  session per surface (record Cursor sandbox/allow-list behavior honestly); a dirty file
  actually triggers a regenerate turn and comes back clean.

---

## 12. Invariants (do not regress)

1. **Two postures, both made real per platform.** Commands fail CLOSED (endpoint denies on
   error; Claude Code hook `exit 2`/deny on its own error; Cursor `failClosed:true`, +
   best-effort/always-logged on sandbox). Code fails SAFE (regenerate, never block/revert).
   This asymmetry is intentional — do not "fix" one to match the other.
2. **Never modify a command or a file.** Only allow / deny / ask / ask-to-regenerate.
3. **Both tiers run on every code scan** — Tier 2 never gated behind a clean Tier 1.
4. **One source of truth** — `src/action-rules.ts` + `RiskCategory` from `guidance.ts`; no
   forked category enum, no hand-edited generated files.
5. **Findings cleared exactly once, at `stop`** — never accumulated across turns.
6. **Audit is the guarantee.** Every deny/ask/finding is logged — including a Cursor block
   the platform dropped — so nothing dangerous is invisible. A scan failure is logged AS a
   failure, never silently "clean."
7. **Zero runtime dependencies** — no Semgrep binary, no npm deps; Tier 2 is the zero-dep
   analog to Semgrep's engine.
8. **Dark by default** — `GATEWAY_ACTION_GUARD` off ⇒ hooks unwired ⇒ nothing gated.

---

## 13. Recommended build order

1. **Command path first** (higher stakes, prevention is simpler than the loop): `action-rules.ts`
   + `POST /action-guard/command` + the two command hooks + fail-closed tests + live deny.
2. **Code path second** (Guardian loop): `action-scanner.ts` + accumulator + `/scan` +
   `/pending` + the scan/stop hooks + loop tests + live regenerate.
3. **Admin tab + unresolved surfacing** last (needed for the `warn` cap-behavior to be real).

Keep each a green phase gate (happy/failure/edge) before the next — same TDD discipline as
CK1. Ships DARK until all three are live-verified.

---

## Sources (contract verification, 2026-08-06)

- Claude Code hooks (`PreToolUse`/`PostToolUse`/`Stop`, `permissionDecision`,
  `stop_hook_active`, 8-block cap, exit-2): https://code.claude.com/docs/en/hooks.md ·
  https://code.claude.com/docs/en/hooks-guide.md
- Cursor hooks (`beforeShellExecution`, `afterFileEdit`, `stop`, `followup_message`,
  `loop_count`, 5-followup cap, `failClosed`): https://cursor.com/docs/hooks.md ·
  https://blog.gitbutler.com/cursor-hooks-deep-dive · https://github.com/johnlindquist/cursor-hooks/
- Cursor `deny`/`ask` ignored (allow-list / sandbox):
  https://forum.cursor.com/t/beforeshellexecution-hook-permissions-allow-ask-ignored-allow-list-takes-precedence/144244 ·
  https://forum.cursor.com/t/beforeshellexecution-returns-permission-ask-but-sandboxed-agent-shell-still-runs-the-command-sandbox-true/155438
- Semgrep Guardian (post-write hook, regenerate-until-clean loop, no command guard):
  https://docs.semgrep.dev/semgrep-guardian/overview
