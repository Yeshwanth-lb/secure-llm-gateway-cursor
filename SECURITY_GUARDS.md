# SECURITY_GUARDS.md — Prompt Guard + Command Guard (detailed explainer)

> One document explaining everything built in the "AI safety guard" line of work:
> **Checkpoint 1 — Prompt Guard** (guarding what the user *asks*) and **Checkpoint 2 v1
> — Command Guard** (stopping the agent from *running* dangerous shell commands on both
> Cursor and Claude Code). Written to be read top-to-bottom by someone new to it.
>
> Deep-dive companions: `PROMPT_GUARD.md` (CK1 spec), `checkpoint.md` (CK1 PRD),
> `checkpoint2.md` (CK2 PRD), `CHECKPOINT2_ACTION_GUARD.md` (full two-mode spec incl. the
> deferred code-scan half). The living status is in `CLAUDE.md` §8.

---

## 0. The big picture — three moments, three guards

This project is a **local gateway proxy** that already redacts PII in both directions. On
top of that we added guards that watch an AI coding agent at **three different moments** in
its work:

```
  ┌─────────────┐        ┌──────────────┐        ┌───────────────┐
  │ 1. USER ASKS│───────►│ 2. AGENT ACTS │───────►│ 3. AGENT WRITES│
  │  (a prompt) │        │ (a command)   │        │  (code to disk)│
  └──────┬──────┘        └──────┬───────┘        └───────┬────────┘
         │                      │                        │
   PROMPT GUARD           COMMAND GUARD             (Code Guard — DEFERRED)
   Checkpoint 1           Checkpoint 2 v1            Checkpoint 2b (not built)
   ADD guidance           BLOCK / ASK                regenerate-until-clean
   (fail OPEN)            (fail CLOSED)              (fail SAFE)
   ✅ SHIPPED             ✅ BUILT (dark)            📋 designed only
```

**Why three separate guards and not one:** the *lever you can pull* depends on *when* you
catch the AI.
- A **prompt** hasn't produced anything yet → you can only *steer* it (add advice). You
  must not block it (too heavy-handed for a mere request), so if the check breaks you let
  it through — **fail OPEN**.
- A **command** is about to run and can still be *stopped* → you block or ask. A missed
  destructive command is unrecoverable, so if the check breaks you deny — **fail CLOSED**.
- **Code** is already written by the time any hook sees it → nothing to block; you can only
  ask the agent to *redo* it. (Designed, deferred — see §7.)

**The one guarantee that always holds:** every guard *logs* every decision to the gateway's
security log. Even when a block is ignored by the platform (Cursor can do that — §5.3),
the attempt is recorded. So the promise we actually keep is **"nothing dangerous happens
without it being visible,"** not "everything dangerous is perfectly blocked."

---

## 1. Shared foundations (both guards use these)

- **The gateway** (`src/server.ts`) — a loopback-only HTTP server on `127.0.0.1:8001`. Both
  guards add a loopback-gated endpoint here.
- **`securityLog`** (`src/security-log.ts`) — an in-memory, admin-token-gated store that MAY
  hold raw text (the raw prompt / the raw command), unlike the PII-safe traffic log. Read via
  `GET /security-log`. Both guards write to it, distinguished by a `kind` field
  (`"prompt-guard"` vs `"command-guard"`).
- **`RiskCategory`** (`src/contracts.ts`) — one shared list of risk labels (sql_injection,
  xss, ssrf, missing_auth, …). Prompt Guard uses it directly; it's the single source of
  truth so nothing forks a second copy.
- **Dark by default** — both guards ship OFF and turn on via an env flag, so they can't
  break anyone until deliberately enabled.
- **Zero runtime dependencies** — everything is Node built-ins. No Semgrep binary, no npm
  packages. This is a hard project constraint (CLAUDE.md §2).
- **Fail-open vs fail-closed** — the defining difference between the two guards, stated once
  here and enforced everywhere: Prompt Guard errs toward *letting through*, Command Guard
  errs toward *denying*.

---

## 2. Checkpoint 1 — Prompt Guard (guard what the user asks)

**Goal:** when the user sends a prompt, detect security/safety risk and, if risky, **inject
guidance into the model's system channel** so it answers more safely. Never edits the user's
message. Never blocks. Logs every decision. Ships dark.

### 2.1 How it decides — inverted two-tier (`src/prompt-analyzer.ts`)
- **Tier 1 — benign-skip filter.** NOT a keyword blocklist. The default is to *analyze*;
  Tier 1 only fast-skips prompts it's confident are trivial (a short factual question, no
  code/imperative). This closes the "keyword-less manipulation" blind spot a keyword gate
  would have.
- **Tier 2 — LLM classifier** (`src/prompt-classifier.ts`). One Anthropic call on the SAME
  upstream the request already uses (no new key), returns `{risk, categories, confidence}`.
  Mandatory for real detection.
- **Verdict cache** — memoizes by prompt text, so a turn that re-sends the same prompt costs
  one classify call, not N. Makes a stronger/slower model practical.
- **Fail OPEN everywhere** — any error/timeout/parse-failure returns `allow`. A miss = no
  guidance, never a dropped request.

### 2.2 What it does with a risky verdict
`src/guidance.ts` holds 18 short guidance templates (one per `RiskCategory`), the **single
source of truth**. `buildGuidance()` concatenates the matched ones under a
`[SECURITY & SAFETY GUIDANCE]` banner. Then, per surface:
- **Claude Code** (on the gateway wire): `src/proxy.ts` injects the guidance block into the
  request `system[]` before forwarding. The user's message text is untouched; existing
  `system[]` is preserved.
- **Cursor** (NOT on the wire — Cursor calls providers server-side): guidance is delivered
  two ways — (a) a static `.cursor/rules/security-safety-guidance.mdc` generated from the
  same `guidance.ts` (always-applied, the real injection path); (b) a `beforeSubmitPrompt`
  hook that POSTs to `POST /prompt-guard` for **logging + severe-block only** (Cursor's hook
  can't add context).

### 2.3 Logging (two stores, never mixed)
- PII-safe traffic log gets **metadata only** (the analyzer decision, no raw text).
- `securityLog` gets the **raw prompt + exact guidance** (admin-gated).
- **Cursor output back-fill** (added this line of work): Cursor's model reply is off-wire, so
  the flagged security-log row is written with no output; when the turn finishes,
  `securityLog.attachResponse()` (called from `POST /log-turn`) joins the redacted reply onto
  the matching row *by prompt text*, so a reviewer sees prompt + guidance + output in ONE
  record.

### 2.4 Status
**Shipped and live-verified** on both surfaces (Claude Code proxy inject; Cursor `.cursor/rules`
A/B; back-fill on the restarted service). Flags: `GATEWAY_PROMPT_GUARD=on`,
`GATEWAY_PROMPT_GUARD_MODEL`, `_TIMEOUT_MS`. Tests: `tests/phase-prompt-guard.test.ts`.

---

## 3. Checkpoint 2 v1 — Command Guard (stop force/destructive execution)

**Goal:** before the AI agent runs a shell command, check it and **block it (`deny`) or hold
it for human confirmation (`ask`)** — *before* it executes. This is the part that stops
"vulnerable/destructive command execution by the agent without our knowledge." Ships dark.

### 3.1 The rulebook — deterministic, no LLM (`src/command-rules.ts`)
Commands are a closed, enumerable set, so this is pure pattern matching (regexes compiled
once at startup — fast, auditable, can't time out). `classifyCommand(command)` returns
`allow | deny | ask` + the category + the exact matched pattern:

| Category | Action | Examples |
|---|---|---|
| `destructive_fs` | **deny** | `rm -rf`, `rm -r -f`, `dd if=`, `mkfs`, `> /dev/sda`, `chmod -R 777 /` |
| `priv_escalation` | **deny** | `sudo`, `su -`, `doas` |
| `remote_exec` | **deny** | `curl … \| sh`, `wget … \| bash` |
| `infra_destructive` | **deny** | `terraform destroy`, `kubectl delete`, `DROP TABLE`, `TRUNCATE TABLE` |
| `git_destructive` | **ask** | force-push (**not** `--force-with-lease`), `reset --hard`, `clean -fdx`, `branch -D`, `push --delete`, `filter-branch/repo`, `commit --amend` |

Rules are checked deny-first, so a command that trips both (e.g. `sudo git push --force`) is
**denied**, not merely asked. `git_destructive` is its own `ask` category because it destroys
*shared history*, a different risk from wiping local files. `--amend` is `ask` for now
(dangerous only if already pushed — a known imperfect call, accepted for v1).

### 3.2 The endpoint — fail CLOSED (`POST /command-guard` in `src/server.ts`)
Loopback-gated. Flow: parse `{command, surface}` → `classifyCommand` → if not `allow`, write
a `securityLog` row (`kind:"command-guard"`, raw command, matched pattern, permission) →
return `{permission, category, user_message, agent_message}`.
- **Fail CLOSED:** any error or unreadable body returns `{permission:"deny"}` — the deliberate
  inverse of `/prompt-guard`'s fail-open. A missed destructive command is unrecoverable, so
  we err toward denying.
- If the guard is **off** (dark default), the endpoint returns `allow` (feature disabled,
  nothing to gate) — but in practice the hooks aren't even wired when off.

### 3.3 Cursor — `beforeShellExecution` hook (`scripts/cursor-command-guard-hook.mjs`)
Cursor runs this before executing a shell command. The hook reads the command from stdin,
POSTs it to `/command-guard`, and relays the verdict to Cursor's `permission` field
(`deny`/`ask`/`allow`).
- **Fail CLOSED:** any error (gateway down, bad stdin, non-200) → the hook returns `deny`;
  the hook is also wired `failClosed:true` so a crash denies too.
- **stdout hygiene:** exactly one JSON object to stdout, diagnostics to stderr, exit 0 even
  on deny (a non-zero exit makes Cursor think the hook crashed).
- Wired into `gateway-service.mjs configure-cursor` **only when `GATEWAY_COMMAND_GUARD=on`**
  (a wired hook with the gateway down would deny every command — so we don't wire it when the
  feature is off).

### 3.4 Claude Code — `PreToolUse` hook (`scripts/claude-code-command-guard-hook.mjs`)
Fires before Claude Code runs a Bash command (matcher `"Bash"`). Reads
`tool_input.command`, POSTs to `/command-guard`, maps the verdict onto Claude Code's
`hookSpecificOutput.permissionDecision` (`allow`/`ask`/`deny`).
- **CRITICAL fail-closed detail:** Claude Code's platform default when a hook errors is
  fail-**OPEN** — exit 1 (or any nonzero-non-2) makes the command **run**, and there is no
  `failClosed` flag. So this hook *manufactures* fail-closed: every error path emits a `deny`
  decision and exits 0. It never falls through to a natural nonzero exit while a command is
  pending. (Proven by a test that runs the hook against a dead gateway and asserts it emits
  `deny` and exits 0, not 1.)

### 3.5 Status
**Built, dark, hermetically tested — not yet live-verified** on a real Cursor/Claude Code
shell session. Flag: `GATEWAY_COMMAND_GUARD=on`. Tests: `tests/phase-command-guard.test.ts`
(10/10). Full suite 230/230 green.

---

## 4. The honest limits (must be understood before trusting it)

1. **Cursor can ignore a block.** Verified against live Cursor docs/bug reports: an
   allow-listed command overrides the hook's verdict, and the *sandboxed* Agent shell ignores
   `ask` (runs the command anyway). So on Cursor, command-blocking is **best-effort +
   always-logged**, not a hard guarantee. Claude Code honors `deny`/`ask` reliably.
2. **Claude Code fails open on hook crash unless the script forces deny** (handled — §3.4).
3. **Command Guard is not yet live-verified** — the hooks are proven hermetically (incl. the
   fail-closed spawn test) but not yet run inside a real editor session, the way Prompt Guard
   was.
4. **Code Guard is not built** — the agent's *generated code* is not scanned/regenerated in
   this build. It relies on Prompt Guard's pre-guidance making code "mostly" safe, which is a
   reasonable v1 stance but not a guarantee (Prompt Guard is fail-open and only fires when the
   classifier flags the prompt). See §7.

---

## 5. Per-surface hook contracts (the verified reference)

| Concern | Cursor | Claude Code |
|---|---|---|
| Guidance at prompt time | `.cursor/rules` (inject) + `beforeSubmitPrompt` (log/severe-block only) | proxy injects into `system[]` |
| Block a command | `beforeShellExecution` → `{permission:"deny"\|"ask"\|"allow"}` | `PreToolUse` (matcher `"Bash"`) → `permissionDecision:"deny"\|"ask"\|"allow"`, or `exit 2` |
| Fail-closed on hook error | `failClosed:true` on the entry | **none** — the script must emit `deny`/`exit 2` itself |
| Verdict reliably honored? | ⚠️ not on sandbox/allow-list | ✅ yes |

*(Full contract detail incl. the deferred code hooks and the `stop_hook_active` 8-block
billing-loop hazard is in `CHECKPOINT2_ACTION_GUARD.md` §4/§5.)*

---

## 6. File map (everything added/changed in this line of work)

**Checkpoint 1 — Prompt Guard (shipped):**
- `src/prompt-analyzer.ts` · `src/prompt-classifier.ts` · `src/guidance.ts` · `src/security-log.ts`
- `scripts/gen-cursor-rules.ts` · `scripts/cursor-prompt-guard-hook.mjs` · `.cursor/rules/security-safety-guidance.mdc`
- proxy inject in `src/proxy.ts`; endpoints `POST /prompt-guard`, `GET /security-log`, back-fill in `POST /log-turn` (`src/server.ts`)
- admin Prompt Guard tab (`src/admin-api.ts`, `src/admin-console.ts`)
- `tests/phase-prompt-guard.test.ts` · docs `PROMPT_GUARD.md`, `checkpoint.md`

**Checkpoint 2 v1 — Command Guard (built, dark):**
- `src/command-rules.ts` (the rulebook)
- `POST /command-guard` + `securityLog` `kind`/command fields (`src/server.ts`, `src/security-log.ts`)
- `GATEWAY_COMMAND_GUARD` flag (`src/config.ts`)
- `scripts/cursor-command-guard-hook.mjs` (`beforeShellExecution`)
- `scripts/claude-code-command-guard-hook.mjs` (`PreToolUse` Bash, self-denies on error)
- wiring in `scripts/gateway-service.mjs configure-cursor` (gated on the flag)
- `tests/phase-command-guard.test.ts` · docs `checkpoint2.md`, `CHECKPOINT2_ACTION_GUARD.md`

---

## 7. Deferred — Code Guard (Checkpoint 2b, designed not built)

Scanning the agent's generated code and looping it to regenerate securely — the
Semgrep-Guardian mechanism (`afterFileEdit`/`PostToolUse` catches the write, `stop`/`Stop`
sends the agent back to fix it, repeat until clean or capped). Designed in full in
`CHECKPOINT2_ACTION_GUARD.md` §6–§7, deliberately **not built** in this pass:
- **Why deferred:** Prompt Guard already pre-guides prompts, so generated code is *mostly*
  safe; the command path is higher-stakes and simpler, so it ships first.
- **The zero-dep decision:** Semgrep Guardian uses the same hook loop, but its engine is a
  Python binary with a network-fetched rule corpus — a dependency that breaks the project's
  zero-dep rule. The plan reuses the loop and replaces Semgrep's engine with the same LLM
  classifier (Tier 2) reading the whole file.
- **The billing-safety gotcha to remember when building it:** the Claude Code `Stop` hook must
  check `stop_hook_active` as its literal first line, or a stubborn false positive re-loops the
  session to the 8-block cap / token budget.

---

## 8. Config summary

| Flag | Default | Turns on |
|---|---|---|
| `GATEWAY_PROMPT_GUARD` | off | Prompt Guard (`=on`) |
| `GATEWAY_PROMPT_GUARD_MODEL` / `_TIMEOUT_MS` | haiku / 4000ms | Tier-2 classifier tuning |
| `GATEWAY_COMMAND_GUARD` | off | Command Guard (`=on`) — also gates whether the Cursor shell hook is wired |

Both guards are OFF by default; enabling one never affects the other.

---

## 9. Verification status at a glance

| Guard | Built | Hermetic tests | Live-verified |
|---|---|---|---|
| Prompt Guard (CK1) | ✅ | ✅ | ✅ both surfaces |
| Command Guard (CK2 v1) | ✅ (dark) | ✅ 10/10 (incl. fail-closed hook spawn) | ❌ not yet — needs flag on + a real Cursor/Claude Code session |
| Code Guard (CK2b) | ❌ designed only | — | — |

Full suite: **230/230 green**, zero-dep, TDD throughout.
