# CLAUDE.md — Operating Manual (living document)

> **This file is the single source of truth for how work happens in this repo.**
> It is **living**: whenever project status changes (a phase starts, tests go green,
> a decision is made), update the **Project Status Ledger** at the bottom in the same
> change. A stale ledger is a bug. See [AGENTS.md](AGENTS.md) for the tool-agnostic
> summary and [DEVELOPERS.md](DEVELOPERS.md) for human setup/run/test detail.

---

## 1. What we are building

A **zero-dependency local LLM gateway proxy** — modules under `src/`, entry point
`secure-llm-gateway.ts`. *(Was single-file per the design docs; modularized 2026-07-09 — see §2.)*

It sits between any LLM client (Cursor, Claude Code, LangChain, AutoGen, raw SDKs) and
three upstream provider families (Anthropic, Gemini, OpenAI-compatible). It:

1. **Redacts PII bidirectionally** — scrubs the request before any byte leaves the
  machine (`[REDACTED_PII_<TYPE>]`) and scrubs the response the model returns
   (`[REDACTED_MOCK_PII]`), *including PII split across streaming SSE chunk boundaries*.
2. **Logs traffic** in a 100-entry in-memory ring buffer (post-redaction snapshots only —
  never persists raw PII).
3. **Exposes an embedded MCP server** (`/mcp`, three transports) with a `get_traffic_logs`
  tool so agents/reviewers can inspect what leaked.

**Design authority:** `newplan.md` (technical design) → `PRD.md` (why/what) →
`IMPLEMENTATION_GUIDE.md` (how/who). If those conflict, `newplan.md` wins.

> **Note on the old design.** `ARCHITECTURE.md` (Python/FastAPI + Presidio, two-plane,
> SQLite/SIEM) is **abandoned** — deleted in the working tree. Do not implement it. The
> current project is the TypeScript single-file design above.

---

## 2. Tech stack & hard constraints


| Constraint        | Rule                                                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | **Node ≥ 22** built-ins **only** (`node:http`, `node:https`, `node:crypto`, `node:readline`, `node:fs`, `node:url`, `node:test`). This machine runs Node v24.                                                                                                                                     |
| Dependencies      | **Zero.** No `npm install` of runtime deps, no frameworks. Zero supply-chain surface is a feature, not an accident.                                                                                                                                                                               |
| Deliverable shape | **Module graph under `src/`** with `secure-llm-gateway.ts` as entry point + public barrel. *(Decision 2026-07-09, Mohit: the original single-file mandate in `newplan.md`/`IMPLEMENTATION_GUIDE.md` was intentionally overridden for maintainability. Still zero-dep, still `.ts` run directly.)* |
| Run               | `node --experimental-strip-types secure-llm-gateway.ts` (or `npx tsx …` on older Node).                                                                                                                                                                                                           |
| Bind              | `127.0.0.1:8000` only (`GATEWAY_HOST`/`GATEWAY_PORT`). Never `0.0.0.0`.                                                                                                                                                                                                                           |
| Auth headers      | **Never redact** auth headers (`x-api-key`, `Authorization`, `x-goog-api-key`). Redaction is **body-only**.                                                                                                                                                                                       |
| No `eval`         | No dynamic code execution, ever. Custom regexes compile once at startup.                                                                                                                                                                                                                          |


If a task seems to require a dependency, stop and reconsider — the answer is almost always
a Node built-in. Flag it in your response rather than silently adding a package.

---

## 3. The non-negotiable workflow: TDD + phase gate

This project is built **test-first, one phase at a time.** The rules below are binding for
every contributor, human or agent.

### 3.1 Test-Driven Development

For every unit of behavior:

1. **Write the test first.** It must fail for the right reason (red).
2. Write the **minimum** code to make it pass (green).
3. Refactor with tests green.

No production code is written without a failing test that demanded it.

### 3.2 The phase gate — 3 e2e tests per phase

After completing **each phase**, you must add exactly **three end-to-end tests** that
exercise the phase's new behavior through the real interfaces (HTTP / MCP / stream), not
mocks of our own code:

- **Happy path** — the intended flow with valid input produces the correct result.
- **Failure path** — a wrong/hostile/malformed input is handled the way the design says
(right status code, right error shape, no crash, no leak).
- **Edge case path** — the boundary that is easy to get wrong (empty body, PII on a chunk
boundary, size limit exactly at cap, terminal-window flush, etc.).

**You may not start the next phase until all three tests for the current phase pass**
(along with every prior phase's tests — the suite is cumulative and always green). A phase
with 2/3 passing is **not done**.

When a phase's three tests go green:

1. Run the **full** suite (`npm test`) — everything must be green, not just the new three.
2. Update the **Project Status Ledger** (§8) — mark the phase done, record the test names.
3. Commit with the phase tag (§6).

### 3.3 Where tests live & how to run them

- Tests live in `tests/` as `*.test.ts`, run with the **built-in Node runner** (zero deps):
  - Full suite: `node --experimental-strip-types --test 'tests/*.test.ts'` (aliased `npm test`).
  - Single phase: `node --experimental-strip-types --test tests/phase-b1.test.ts`.
- E2e tests spin up the **real gateway** on an ephemeral port + a **local fake upstream**
(`:9101`, JSON + SSE modes) and drive it over HTTP/MCP. The fake upstream is a shared
test helper — build it in Phase 0 / early Phase C scaffolding, reuse everywhere.
- Tests must be **hermetic**: no real network to Anthropic/Gemini/OpenAI, no reliance on
wall-clock timing beyond generous timeouts, cleaned-up servers in `after()` hooks.

---

## 4. The phases (build order)

Derived from `IMPLEMENTATION_GUIDE.md`. Dependency graph:

```
Phase 0 (contracts) ─┬─ A1 ─► A2 ─┐
                     └─ B1 ─► B2 ─┼─► Phase C
                          B3 ─────┘
```


| Phase  | Scope (one line)                                                                                    | Owner     | Design ref       |
| ------ | --------------------------------------------------------------------------------------------------- | --------- | ---------------- |
| **0**  | Skeleton, config loader, contracts as throwing stubs, `GET /healthz`.                               | pair      | IG Phase 0       |
| **A1** | 7 default redaction rules (Luhn CC), custom-rule loader, `redactText`/`redactJson`.                 | Mohit     | newplan §3.1–3.3 |
| **A2** | `StreamRedactor` — SSE framing, rolling holdback, terminal flush injection.                         | Mohit     | newplan §3.4     |
| **B1** | `resolveRoute` (5-tier), header forwarding (hop-by-hop strip, `accept-encoding: identity`).         | Yeshwanth | newplan §2       |
| **B2** | Proxy pipeline (body cap→route→scrub→forward→scrub response), traffic ring buffer, admin endpoints. | Yeshwanth | newplan §4, §6   |
| **B3** | MCP server: JSON-RPC 2.0 over Streamable HTTP + legacy HTTP+SSE + stdio; `get_traffic_logs`.        | Yeshwanth | newplan §5       |
| **C**  | Integration + the 6 acceptance tests, hardening pass, runbook smoke.                                | pair      | newplan §8       |


**Frozen contracts** (locked in Phase 0, changed only by mutual agreement — see
`IMPLEMENTATION_GUIDE.md` "Contracts"): `Provider`, `RouteResult`, `RedactionRule`,
`redactText`, `redactJson`, `LogEntry`, `trafficLog`, `StreamRedactor`. Both workstreams
code against these seams; stubs pass through until filled so no one is blocked.

### 4.1 Concrete phase-gate test targets

The three tests per phase should aim at these (adapt names, keep the happy/failure/edge trio):

- **Phase 0** — happy: `/healthz` → 200; failure: unknown path → 404 JSON hint; edge: body over cap → 413.
- **A1** — happy: object with email/SSN/CC/api-key → correct tokens + counts; failure: malformed input degrades to raw-text scrub (no throw); edge: non-Luhn 16-digit number left untouched.
- **A2** — happy: clean SSE stream passes through with valid framing; failure: bad/partial JSON in a `data:` event doesn't crash the redactor; edge: email split across 3 chunks → `[REmDACTED_MOCK_PII]`, PII in final window flushed before terminal event, nothing dropped.
- **B1** — happy: path-prefix route resolves to right upstream; failure: no signal → 404 hint; edge: ambiguous `/v1/models` resolved by header sniff.
- **B2** — happy: e2e request through fake upstream logs an entry with correct char counts + matched rules; failure: upstream down → 502 JSON, entry logged; edge: snapshot of a request full of PII contains **no** raw PII.
- **B3** — happy: `initialize`→`tools/list`→`tools/call get_traffic_logs` over Streamable HTTP; failure: unknown method → `-32601`; edge: stdio mode keeps stdout protocol-pure (diagnostics on stderr).
- **C** — the 6 acceptance criteria from `PRD.md` §7 as the happy set, plus failure/edge hardening (malformed JSON degrade, zero-length-regex guard, 127.0.0.1 bind confirmed).

---

## 5. Coding conventions

- **TypeScript, single file.** Organize with clear section banners (`// ===== ROUTING =====`).
Keep the frozen-contract types near the top, right after imports.
- Match the surrounding style; prefer small pure functions for the redaction core (easy to
unit-test), side effects (server, logging) at the edges.
- **Never log raw PII.** Snapshots and log entries store post-redaction text only. This is a
security invariant, not a style preference — a test guards it (B2 edge).
- **Fail safe on the inbound path:** if redaction of a request cannot complete, do **not**
forward it unredacted. Prefer erroring over leaking.
- Errors are JSON with a helpful message + correct status (`413`, `404`, `502`, `-32601`).
- In **stdio MCP mode**, all human-readable output goes to **stderr**; stdout is JSON-RPC only.

---

## 6. Git & commit discipline

- Work on a branch, not `main`. Branch per phase: `phase/b1-routing`.
- Commit only when the user asks; when you do, tag the phase and the gate status:
  - `feat(b1): routing + header forwarding — phase gate green (3/3)`
  - Body: list the 3 e2e test names and confirm full suite green.
- End commit messages with the required trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- Do not commit `.env`, `*.db`, or local config. (`.gitignore` still has stale Python
entries — add the TS/Node entries when you touch it; see DEVELOPERS.md.)

---

## 7. Definition of Done (per phase)

A phase is **done** only when **all** of these hold:

- [ ] Behavior implemented per the design ref.
- [ ] 3 e2e tests (happy / failure / edge) written and **passing**.
- [ ] Full cumulative suite green (`npm test`).
- [ ] No new runtime dependency introduced.
- [ ] No raw PII in any log/snapshot/test fixture output.
- [ ] Project Status Ledger (§8) updated in the same change.

---

## 8. Project Status Ledger  *(UPDATE THIS — it is the living part)*

**Last updated:** 2026-08-10 — **ALL THREE GUARDS ENABLED LIVE on :8001 + wired into Cursor (demo day).**
Plist (`tech.skylo.secure-llm-gateway.plist`) now sets `GATEWAY_COMMAND_GUARD=on` + `GATEWAY_ACTION_GUARD=on`
+ `GATEWAY_ACTION_GUARD_TIER2=off` (deterministic Tier-1, no key/latency) alongside the existing
`GATEWAY_PROMPT_GUARD=on`; service booted-out/bootstrapped to pick them up (health OK, proxy + MCP still
serving this session). Verified live on :8001: prompt-guard 200; command-guard `rm -rf /`→deny,
`git push --force`→ask, `ls`→allow (audit rows `kind:"command-guard"` confirmed); code-guard `/action-guard/scan`
returns findings (was 404) + `/pending` builds the regenerate message. Cursor re-`configure-cursor`d with
command guard on (`beforeShellExecution`, fail-closed) + `afterFileEdit`→`cursor-action-scan-hook.mjs` added
manually (configure-cursor doesn't wire it). **Cursor code-guard = scan+accumulate+audit only; the
regenerate LOOP is still Claude-Code-only** (Cursor stop/regenerate followup never built — CK2b deferral).
Two throwaway-gateway demo scripts added: `scripts/demo-command-guard.sh` (drives the real Cursor hook,
deny/ask/allow + fail-closed) + `scripts/demo-code-guard.sh` (full scan→accumulate→regenerate→read-once loop,
Tier-1). Backups: `*.plist.demo-bak`, `~/.cursor/hooks.json.demo-bak`. **Cursor must be RESTARTED to load the
new hooks.** Gemini web extension still needs the manual browser recovery (Local Network Access re-allow +
extension/tab reload) — unrelated to this change. Prior
2026-08-07 (later) — **Code Guard (Checkpoint 2b) built + gate green (14/14, suite 245/245).**
The deferred "correct" half of Action Guard: scans the CODE an agent just wrote and loops it to
regenerate securely (Semgrep-Guardian mechanism, zero-dep). New `src/action-scanner.ts` = TWO-TIER,
both run UNCONDITIONALLY in parallel + merged (`scanCode`): Tier-1 deterministic patterns (`scanTier1`
— string-concat/interpolated SQL, eval/`new Function`, exec-with-input, weak crypto md5/sha1, hardcoded
secrets, innerHTML/dangerouslySetInnerHTML) + Tier-2 LLM (`src/action-code-classifier.ts`
`classifyCodeViaAnthropic`, reuses the request's own Anthropic upstream+auth, no new key — catches what
patterns can't: missing-auth/IDOR/SSRF/deserialization). Tier-2 NEVER gated on a clean Tier-1 (Tier-1 is
structurally blind to those). **FAIL-SAFE** (inverse of Command Guard's fail-closed): code is already on
disk, nothing to block — any scan error returns empty findings + an `action-guard-error` audit row, never
throws/blocks. New `src/action-guard-store.ts` = per-`conversation_id` findings accumulator (deduped,
read-once/clear-on-`take`) — required because the scan hook fires per-edit but the stop hook fires per-turn
with no edited-file list. Two loopback endpoints (server.ts): `POST /action-guard/scan` (scan+accumulate+
loud `kind:"action-guard"` audit row, metadata only — raw code NEVER stored) + `GET /action-guard/pending`
(drain+clear, builds the "regenerate securely" message). Three hooks: `claude-code-action-scan-hook.mjs`
(`PostToolUse` Edit|Write — reads the file, fail-SAFE), `claude-code-action-stop-hook.mjs` (`Stop` —
**`stop_hook_active` short-circuit is the literal first logic, a billing-safety requirement**; blocks with
regenerate reason if findings remain), `cursor-action-scan-hook.mjs` (`afterFileEdit`, one-line stdout).
Ships DARK (`GATEWAY_ACTION_GUARD=on`, default off; Tier-2 on unless `_TIER2=off`; `_LOOP_LIMIT=5`,
`_CAP_BEHAVIOR=warn`). `securityLog` extended `kind:"action-guard"|"action-guard-error"` + file/findings
fields (`attachResponse` guarded against rows without `rawPrompt`). **Hermetic only — no live shell-hook
verify yet** (Tier-2 tested via `setCodeScanner` injection seam; +2 spawn tests prove the Stop hook honors
`stop_hook_active` and fails safe on an unreachable gateway). NOT yet built from the CK2b spec: the Cursor
`stop`/regenerate followup, the cap-behavior `block` path exercised live, admin-console surfacing of the
loud row, and `gateway-service.mjs configure-*` wiring. `tests/phase-action-guard.test.ts`. Prior
2026-08-07 — **Command Guard (Checkpoint 2 v1) built + gate green (10/10, suite 230/230).**
Guards the shell COMMANDS an AI agent runs (the "prevent" half of Action Guard; the code-scan
"correct" half is deferred to CK2b — see `checkpoint2.md` §11 + `CHECKPOINT2_ACTION_GUARD.md`). New
`src/command-rules.ts` = zero-dep deterministic matcher (`classifyCommand`): `deny` destructive
(`rm -rf`, `curl|sh`, `sudo`, `DROP TABLE`, `terraform destroy`) / `ask` history-rewrites (force-push
[not `--force-with-lease`], `reset --hard`, `clean -f`, `branch -D`, `filter-branch`, `--amend`) /
else `allow`. New loopback `POST /command-guard` (server.ts) — **FAIL-CLOSED** (any error/unreadable
body ⇒ `deny`, the inverse of `/prompt-guard`), logs deny/ask to `securityLog` (`kind:"command-guard"`,
raw command, matched pattern). Two hooks: `scripts/claude-code-command-guard-hook.mjs` (`PreToolUse`
Bash — **self-denies on any error**, since Claude Code's platform default is fail-OPEN/exit-1-runs) +
`scripts/cursor-command-guard-hook.mjs` (`beforeShellExecution`, `failClosed:true`; wired into
`gateway-service.mjs configure-cursor` ONLY when `GATEWAY_COMMAND_GUARD=on`). Ships DARK
(`GATEWAY_COMMAND_GUARD=on`, default off). Verified hook contracts baked in (Cursor may ignore `deny`
on sandbox/allow-list ⇒ best-effort + always-logged; Claude Code needs the manufactured fail-closed).
`securityLog` extended: `kind` discriminator + command fields, prompt-guard fields now optional
(back-compat). PRD `checkpoint2.md`, spec `CHECKPOINT2_ACTION_GUARD.md`. **Hermetic only — no live
Cursor/Claude-Code shell-hook verify yet** (+1 spawn test proves the Claude Code hook denies+exits 0,
not 1, when the gateway is unreachable). `tests/phase-command-guard.test.ts`. Prior
2026-08-06 (later still ×3) — **Cursor output back-fill into the security log**
(security-team visibility). Cursor's model reply is off-wire, so the flagged `cursor-hook` security-log
row had `output:(none)` while the reply lived only in the Traffic tab (via the `stop` turn-log hook).
New `securityLog.attachResponse(surface, turnPrompt, response)` + a call in `/log-turn` (server.ts) now
join them: when a Cursor turn finishes, the REDACTED reply is back-filled onto the matching flagged row
so a reviewer sees prompt + guidance + output in ONE record, like a claude-code row. Correlation is by
**prompt text** (exact-trim, else the turn prompt CONTAINS the flagged prompt — multi-message turns);
the two Cursor hooks share no turn id. Cursor-scoped (`source` starts with `cursor`), no-op if nothing
matches, PII redacted before store. Suite **220/220** (+3 e2e: happy fill / unrelated+non-cursor no-op /
PII-redacted + superset-prompt match). TDD, zero-dep. **LIVE-VERIFIED end-to-end 2026-08-06 (later ×4):**
launchd service restarted (PID 1599→9432, picks up `src/` since it runs `.ts` direct); drove the two real
Cursor hooks over loopback — risky prompt to `POST /prompt-guard` → tier-2 `inject` (real `claude-sonnet-5`,
cats sql_injection+missing_auth) wrote a `cursor-hook` row with no output; matching `POST /log-turn` → the
REDACTED reply back-filled onto that ONE row (prompt + guidance + response together), confirmed via
`GET /security-log`. Also re-confirmed the Cursor `.cursor/rules` guard flagging live in real Cursor Agent
this session. Prior
2026-08-06 (later still ×2) — **Extensive prompt-guard verification, both surfaces.**
Suite 217/217. (1) LIVE Cursor `/prompt-guard` matrix against the running 8001 service (real
`claude-sonnet-5` classifier): 25 prompts → **15/15 recall on risky (correct categories), 0/10 false
positives** — educational lookalikes ("explain what SQL injection is", "how JWT works") correctly
`allow`; Tier-1 trivia fast-skips at 1-3ms, Tier-2 calls 1.6-4.2s; +15 `cursor-hook` security-log
entries (raw stored admin-gated only). (2) CONTROLLED Claude Code proxy test (real `classifyViaAnthropic`
network path + fake upstream, NO module stub): risky prompt → guidance injected into `system[]`, user
message byte-identical, prior `system` preserved, `claude-code` security-log entry, tier 2; classifier
upstream 500 → **fail-OPEN** (forwarded, no guidance, no log). (3) LIVE Claude Code wire (this session
routes through 8001): **98/98 anthropic turns analyzed at Tier 2**, `allow`, ~500-700ms — guard engaging;
classifier authenticates over the OAuth Bearer (same auth+endpoint as the main call, which succeeds);
bogus-key probe confirmed live fail-open (291ms allow, request not dropped). No `claude-code` flagged
entries this session only because all prompts were benign. Residual: a risky prompt flagged+injected on
the REAL OAuth Claude Code session wasn't re-captured today (recorded done 2026-08-05); Cursor's actual
`beforeSubmitPrompt` hook process (vs curling the endpoint) still hermetic-only. Prior — PG2
**live-verified on real Cursor Agent** via an
A/B rules test (rules present ⇒ Agent refused the SQL-concat code + cited project security guidance;
rules removed ⇒ Agent emitted the unsafe f-string). Closes PG2's "no live-Cursor verify yet" gap for
the `.cursor/rules` injection path; the `beforeSubmitPrompt`/`POST /prompt-guard` log-path stays
hermetic-only. File restored + confirmed == `src/guidance.ts`. Prior 2026-08-06 (later) — Prompt-guard
**Build 2: Cursor delivery** (PG2, gate green).
Second surface done. Cursor isn't on the gateway wire, so delivery = static `.cursor/rules/`
generated from `src/guidance.ts` (`npm run cursor:rules`, the injection path — always applied,
unskippable) + a fail-OPEN `beforeSubmitPrompt` hook (`cursor-prompt-guard-hook.mjs`, log +
severe-block only, since Cursor's hook is block-only) POSTing to new loopback-gated `POST
/prompt-guard`, which runs the SAME `analyze()` + logs to `securityLog` as `surface:cursor-hook`
(Tier-2 reuses the gateway's own Anthropic key; no key ⇒ Tier-1 only). Wired into
`gateway-service.mjs configure-cursor`. Suite **217/217** (+3 Cursor e2e). Hermetic — no
live-Cursor verify yet. Prior 2026-08-06 — Prompt-guard **high-recall v2**: +6 implementation-risk
categories (xss, ssrf, idor, path_traversal, open_redirect, weak_crypto) with guidance;
recall-biased classifier prompt (flags security-sensitive CODE-GEN even when phrased casually,
still lets educational questions through); **verdict cache** (one classify per unique prompt —
makes a slow model practical across Claude Code's many per-turn sub-requests); latest-user-message
clean view (was joining whole re-sent history). **Deployed on the real 8001 launchd service**
(`tech.skylo.secure-llm-gateway.plist`: `GATEWAY_PROMPT_GUARD=on`, `_MODEL=claude-sonnet-5`,
`_TIMEOUT_MS=12000`; Zscaler CA already present). Live-verified: IDOR/XSS/SSRF/open-redirect now
caught, "explain what SQL injection is" still allowed; cache 7095ms→0ms on repeat. Suite 214/214.
Prior 2026-08-05 (later) — Prompt-guard Build 1 + admin **Prompt Guard tab**.
Security-log now also stores the model's (distilled, redacted) OUTPUT per flagged turn; new
JWT-gated `GET /admin/api/prompt-guard` + a "Prompt Guard" tab in `/admin` showing, per row,
prompt + guidance + generated output (expandable). Live-verified through real Claude Code
(jailbreak → inject; SQL-concat → inject → model returned parameterized query) AND in the
dashboard. Suite 213/213. **Op note:** gateway needs `NODE_EXTRA_CA_CERTS` here or all
Anthropic calls fail (see memory [[gateway-node-tls-ca]]); Tier-2 timeout raised 600→4000ms
(real haiku classifier is 1.2–2.4s). Earlier 2026-08-05 — Prompt-guard Build 1 (PG1, Checkpoint 1):
shared analyzer (inverted two-tier — benign-skip Tier-1 + mandatory Tier-2 LLM classifier,
Anthropic-only v1, FAIL-OPEN) + Claude Code guidance injection into request `system[]` +
two-store logging. Ships DARK behind `GATEWAY_PROMPT_GUARD=on`. Cursor delivery = Build 2 (rules +
`beforeSubmitPrompt` hook, verified block-only). See `checkpoint.md`. Prior 2026-08-04 — Admin
dashboard (U): zero-dep login-gated control plane (analytics + AI controls + audit) at `/admin`,
`node:sqlite` + `node:crypto`, suite 197/197 (live UI check pending). Prior 2026-08-03 — DeepSeek (T) live-verified; Gemini uploads armed;
Chrome Workspace-panel composer model-sync fixed (delete+insert).

**Working surfaces (Chrome unless noted):** gemini.google.com · Google Workspace panels
(Gmail/Docs/Sheets/Slides/Drive/Chat — Drive slightly flaky) · chatgpt.com (also Firefox) ·
grok.com · chat.deepseek.com. Cursor: block-on-prompt + tool-scrub + per-turn logging +
unblockable-path audit. Gateway core + console + Cursor shim complete (Phases 0–C, D, E, I, J–O).
**Admin dashboard (U):** `GET /admin` (seed via `npm run admin:seed`); analytics fed by a
`trafficLog` listener (metadata only), per-surface controls + global PII-type toggles, audit log;
`/internal/events` + `/internal/config/:surface` for enforcement points (extension/Cursor wiring
documented, not yet wired). See `ADMIN_DASHBOARD.md`.

**Uploads** (attach-time scrub; unscannable → block; Office DOCX/XLSX/PPTX → zip+XML scrub):
armed + probed on ChatGPT, Grok, DeepSeek, gemini.google.com. Workspace-panel upload endpoint
unprobed (the attach-time guard still scrubs; only the wire backstop is uncovered there).

**Key operational gotchas:**
- **Gateway restart** → Chrome re-asks Local Network Access; Allow it + reload the extension, or
  every SW→loopback `/redact` fails and sends/uploads block as `gateway-unreachable`.
- **Workspace "Ask Gemini" composer** (appsElements `role=combobox`, controlled model): write the
  redacted text via `execCommand("delete")` then `insertText`, scoped by the `appsElements` class —
  **NEVER synthetic keystrokes** (they break normal sends). See `composer.js` `writeText` +
  memory `workspace-composer-model-sync`. Google moves this; re-run the editable-dump diagnostic
  before changing the write.
- **DeepSeek encrypts its request body** (WASM proof-of-work) → the tripwire is BLIND on its chat
  send; the composer intercept (a plain `<textarea>`) is the sole protection. Its UPLOAD body is
  plaintext FormData, so the upload backstop works there.
- **Provider labels:** ChatGPT/Grok/DeepSeek log under the FROZEN `openai` enum and are told apart
  by `source`; the console relabels `*-web-extension` → the surface name. Never widen the enum.
- **A stale generated package is an UNPROTECTED surface** (not fail-closed): run `npm run ext:build`
  after touching `extension/`; `tests/phase-cross-browser.test.ts` guards it.
- **Cursor has two unblockable leak paths** (messages queued while busy + auto-attached open/selected
  files) — audited via the `unchecked` pill + desktop alert, not blockable in-hook.
- Ring-buffer `entries` is **not** chronological — sort by `timestamp` before taking "the latest".
- A `\[REDACTED_PII_[A-Z_]+\]` scan silently misses `IPV4`/`IPV6` (they end in digits).

> **Historical fix notes** — earlier per-phase dated writeups (Phases G–T live-debugging
> narratives) were pruned during handoff cleanup. The phase tables below remain the living gate record.

| Phase | Status | E2e tests (happy / failure / edge) | Suite green? | Notes |
|---|---|---|---|---|
| 0 — Skeleton & contracts | ✅ Done | `/healthz`→200 / unknown→404 hint / body>cap→413 | ✅ 3/3 | `tests/phase-0.test.ts`. |
| A1 — Redaction engine | ✅ Done | email/SSN/CC/api-key tokens+counts / malformed→raw scrub no-throw / non-Luhn untouched | ✅ 8/8 | Defaults: JWT (incl. short payload + padding), PRIVATE_KEY, CONN_STRING, expanded API_KEY, PHONE_US/IN, PAN_IN, AADHAAR. `tests/phase-a1.test.ts`. |
| A2 — StreamRedactor | ✅ Done | clean SSE / bad JSON / split email + Anthropic flush regressions | ✅ 7/7 | Anthropic thinking/text blocks, `thinking_delta` PII scrub, JWT split-stream. `tests/phase-a2.test.ts`. |
| B1 — Routing | ✅ Done | prefix route / no signal / ambiguous `/v1/models` sniff | ✅ 5/5 | `tests/phase-b1.test.ts`. |
| B2 — Proxy + log | ✅ Done | bidi redaction + log / upstream down / no raw PII snapshot | ✅ 3/3 | `tests/phase-b2.test.ts`. |
| B3 — MCP server | ✅ Done | Streamable HTTP / unknown method / stdio protocol-pure | ✅ 3/3 | `tests/phase-b3.test.ts`. |
| C — Integration | ✅ Done | 6 acceptance criteria + hardening (loopback-only, no cloud mode) | ✅ 12/12 | `tests/phase-c.test.ts`. |
| D — Traffic inspector | ✅ Done | console shell + aliases + `/logs` polling | ✅ 4/4 | `tests/phase-d.test.ts`. |
| E — Control-plane console + `/api` | ✅ Done | MCP/browser negotiation + live rules/model controls | ✅ 9/9 | Admin-token gate when `GATEWAY_ADMIN_TOKEN` set. `tests/phase-e.test.ts`. |
| I — Cross-platform integration | ✅ Done | shared-log aggregation / fail-closed health hook / global Cursor config / concurrent start | ✅ 6/6 | Loopback-only `http` MCP for Cursor + Claude; hook skips non-secure-gateway MCP. `tests/phase-i.test.ts`. |
| J — Cursor OpenAI↔Anthropic shim | ✅ Done | claude-alias translates + gpt passes through (one endpoint) / missing-messages 400 + blocked-alias 403 / streaming split-PII reframed to OpenAI | ✅ 3/3 | `src/openai-anthropic-shim.ts`. Model-name routing on the shared `/openai` endpoint (Cursor has one global base-URL override). Model-policy ordering fixed (policy checks the RESOLVED Claude model). `tests/phase-j.test.ts`. |
| K — Cursor block-if-PII hook | ✅ Done | file-read PII denied / clean allowed + malformed-stdin fail-closed / prompt secret blocked, clean allowed **+ 2 regressions (2026-07-27): `@`-mention file blocked (bypass) / Cursor's own `user_email` + unresolvable `@Web`-style tokens never block** | ✅ 5/5 | `scripts/cursor-redact-hook.mjs` + `POST /detect` (loopback-gated, never logged). Block-only (these prompt/file hooks can't rewrite). Now also resolves `@`-mentions from the prompt and scans those files — closes the live-found attachment bypass (§ note above, `CURSOR_INTEGRATION_PLAN.md` §7.1). `tests/phase-k.test.ts`. |
| N — Queue-bypass leak audit | ✅ Done 2026-07-27 | approved prompt logs a CHAT row NOT flagged unchecked / a queued PII message the gate never saw is flagged `unchecked` + `piiDetected` (no raw PII stored) / absent approval history flags nothing, a partly-queued turn is flagged | ✅ 3/3 (125/125) | Cursor never invokes `beforeSubmitPrompt` for a message queued while the agent is busy — **unblockable, so audited**. Approval ledger = SHA-256 hashes only (`cursor-approved-prompts.json`); `LogEntry.unchecked` + Inspector pill. See `CURSOR_INTEGRATION_PLAN.md` §7.3. `tests/phase-n.test.ts`. |
| O — Cursor attached-file leak audit | ✅ Done 2026-07-28 | attached-file PII flagged `unchecked` + `piiDetected` without dumping the file / a stamped `user_email` outside `<attached_files>` does NOT flag the turn (extraction is attached-files-only) / an APPROVED typed prompt still yields `unchecked` when an attachment leaks (+ multiple `<attached_files>` blocks all scanned) | ✅ 3/3 (130/130) | Auto-attached open/selected files ride the request as `<attached_files>` but never reach `beforeSubmitPrompt` — **unblockable like a queued send**, and previously invisible (stripped before logging). Turn-log hook sends them as `scanExtra`; `/log-turn` counts their PII into the row + marks `unchecked`, stores/shows nothing of the file. See § Phase O note above. `tests/phase-o.test.ts`. |
| M — Cursor per-turn CHAT logging | ✅ Done 2026-07-27 (+ compaction fix 2026-07-28) | finished turn logged with redacted prompt + assistant output (envelope stripped) / missing transcript + dead gateway skip logging without breaking (then retry) / re-fire never double-logs, tool-only + unfinished turns skipped **+ 2 regressions: a compacted transcript keeps logging; a legacy counter ahead of it still logs the newest turn** | ✅ 5/5 (127/127) | `scripts/cursor-turn-log-hook.mjs` on `stop` (**fail-open** — observational, gates nothing) replays turns from Cursor's own `transcript_path` into `POST /log-turn` (+`provider` param; stores redacted only). Console labels `cursor-*` rows "cursor" — `Provider` enum untouched. **Live-verified: 7 real turns with prompt + output.** `tests/phase-m.test.ts`. |
| L — Cursor tool-data scrub | ✅ Done | postToolUse scrub stores the REDACTED payload (tokens only, never raw) / gateway-down → preToolUse deny + postToolUse withhold (no raw) / nested input scrubbed, clean input untouched | ✅ 3/3 | `scripts/cursor-tool-redact-hook.mjs` + `POST /redact` (loopback-gated, never logged). Rewrite hooks: `preToolUse.updated_input`, `postToolUse.updated_mcp_tool_output`. **Live-verified 2026-07-14** against Cursor 3.9.16 — field names confirmed `tool_input` (object) / `tool_output` (string); real-payload scrub of EMAIL+CC end-to-end. **Audit snapshot change 2026-07-29:** the `/redact` audit row now stores the SCRUBBED text (snapshot + clean view) instead of an empty snapshot — output-side (`postToolUse`) fills the response pane, input-side (`preToolUse`) the request pane, capped by `SNAPSHOT_CHARS`. Raw PII still never persisted (the stored text is already tokenised). `tests/phase-l.test.ts`. |

**Workspace response-capture — final state (2026-07-30). ALL 7 surfaces now capture the reply.** Redaction (security) already worked everywhere; response-text for the audit log is now covered on all 7:
- **gemini.google.com / Docs / Sheets / Slides** — semantic selectors + text-change detection + last-non-empty + generation-wait. Reliable every turn.
- **Chat / Gmail / Drive** (obfuscated rotating-class `role=listitem` panels, no stable selector) — the SHAPE path was made to work by REJECTING conversation-list chrome instead of scoping it out: `response-finder.looksLikeMetadata` drops any short/medium block that is (a) mostly sender/timestamp fragments OR (b) has an ISOLATED "1 min"/"Ask Gemini" delimited piece (the two garbage forms seen live — "Ask Gemini , 1 min ," and a prior message stamped "…, 1 min ,"). With metadata dropped, `findScope` re-widened to 16 hops safely. Unit-tested (`tests/phase-gemini-response.test.ts`) with the exact garbage + real short/medium/long replies. **Live-verified 2026-07-30: Drive 4/4, Gmail 3/4, Chat 3/4 correct + fast, no garbage.**
- **Known minor edge:** the FIRST turn of a session on the obfuscated panels can log `(none)` (the shape anchor/baseline races the very first reply). Every subsequent turn is clean. Not chased — it's one row per session, audit-visibility only.

Two other same-day fixes that made the above hold: the **generation-wait** fix (`c34fe65` — never settle on a "Collecting info…" placeholder; wait for `isGenerating()` false, `turnTimeoutMs` → 120s backstop) and the **settle-on-text-stability** fix (`2e896f3` — restart the settle window only when the reply TEXT changes, not on every mutation; short quiet when generation is done, 3× fallback while a Stop control lingers — this removed a ~1-minute log delay on Chat). `9314f14`'s naive scope widening (which logged metadata) was reverted before the metadata-rejection approach replaced it.

**Generation-wait fix (2026-07-30, `c34fe65`) — applies to ALL apps.** Capture settled on 2.5s of DOM quiet, so a slow/deep turn that sat on an intermediate "Gemini response / Collecting info…" state longer than that logged the PLACEHOLDER and missed the real answer. Now `captureAndLogTurn` arms the settle countdown only when `replyReady()`: `composer.js isGenerating()` reports NO visible Stop control (model finished) AND the text isn't an empty/label/"Collecting info…" placeholder AND differs from the pre-send snapshot. `turnTimeoutMs` 30s → 120s (backstop only, so deep-research turns aren't cut off). Stored text is stripped of the leading "Gemini response"/"Show thinking" label. This is the fix that keeps the 4 working apps correct on long replies.

**Gemini-web extension (Phase G) — sub-ledger.** Separate deliverable under `extension/`; design + gates in `scripts/gemini_imp.md`. DOM stages are **browser-gated** (validated against the live Gemini page, not `npm test`) — see `extension/README.md`.

| Stage | Status | E2e / unit tests (happy / failure / edge) | Suite green? | Notes |
|---|---|---|---|---|
| G1 — Gateway `/redact` contract | ✅ Done | single email→fixed token / malformed→200 empty (shipped behavior) / multi-PII replaced + clean untouched | ✅ 3/3 | Verification only — endpoint reused UNCHANGED (no map). `tests/phase-gemini.test.ts`. |
| G-core — Interceptor control logic | ✅ Done | loop guard (synthetic/in-flight/untrusted not intercepted) / fail-closed decision / tripwire predicate | ✅ 7/7 | Pure, headless. `extension/src/interceptor-core.js` + `tripwire.js`; `tests/phase-gemini-core.test.ts`. |
| G2 — Extension skeleton (loads/locates) | 🟡 Scaffolded | manual: activates on gemini.google.com, locates composer / inert on other domains / waits for late-rendered composer | n/a (browser) | `manifest.json`, `loader.js`, `content-bridge.js`, `composer.js`. Selectors need live tuning. |
| G2 — Extension skeleton (loads/locates) | ✅ Live-verified 2026-07-20 | loads on gemini.google.com, `composer match: div.ql-editor[contenteditable="true"]` confirmed live / inert off-domain / SPA late-render handled | n/a (browser) | First composer selector matches the real Gemini DOM. |
| G3 — Intercept + redact + re-submit | ✅ Live-verified 2026-07-20 | e2e 8/8 (headless) + **real gemini.google.com: real email typed → sent bubble shows `[REDACTED_PII_EMAIL]`, raw never sent** / gateway-down blocks send / send-button path | ✅ e2e 8/8 + live | `extension/test/e2e/run.mts`. Live proof resolved the two hardest risks: (a) synthetic re-submit DOES trigger Gemini's Angular send; (b) **Quill model-sync** — a bare `textContent` write leaked raw because Gemini reads Quill's Delta, which syncs from the DOM ASYNC; fixed with `execCommand("insertText")` in `composer.writeText` + a 120ms yield before re-fire so the Delta absorbs the change. |
| G-CORS — Background SW fetch path | ✅ Fixed + live-verified 2026-07-20 | page-world `/redact` is CORS-blocked → moved to background SW; gateway 403'd the SW's `chrome-extension://` origin → gateway now allows extension origins on `/detect`+`/redact` only | ✅ 104/104 | `src/background.js` + bridge relay; `src/server.ts` `isExtensionOrigin`. Foreign http(s) origins still blocked; hook endpoints expose no stored data. Port: gateway runs **8001** (not 8000) — extension defaults + `host_permissions` updated. |
| G-CORS-PNA — Private Network Access preflight (regression) | ✅ Fixed + live-verified 2026-07-29 | happy: extension-origin preflight echoes ACAO + `access-control-allow-private-network:true`, actual POST also carries ACAO / failure: foreign http(s) origin still gets no CORS / edge: extension grant scoped to hook paths (`/logs` denied), loopback keeps full CORS | ✅ 144/144 | **A Chrome update turned on PNA enforcement**: the SW `fetch` to `127.0.0.1` now triggers a preflight Chrome BLOCKS unless the gateway answers `Access-Control-Allow-Private-Network: true` + ACAO for the `chrome-extension://` origin. `corsHeaders` granted neither (loopback-only, no PNA) → **every extension send failed as "gateway unreachable" → nothing logged on ALL surfaces** (looked like the response-capture regression but was total). Found live by watching the gateway log: a real gemini.google.com send produced ZERO `/redact`+`/log-turn`. `corsHeaders` now grants extension origins on hook paths + echoes the PNA header, and CORS is applied to EVERY response (was OPTIONS-only, so the actual body was unreadable by the SW). NOT the Cursor work / not selectors. `tests/phase-gemini-cors.test.ts`. |
| G6 — Per-turn logging (provider+model+clean view) | ✅ Live-verified 2026-07-20 | `/log-turn` unit-tested (gemini entry, redacted prompt+response, clean view, no raw PII) + **live: Inspector shows `gemini / gemini-flash · CHAT`, clean view = redacted user prompt + full assistant output** | ✅ 106/106 + live | New `POST /log-turn` logs ONE `CHAT` row per turn: `provider:gemini` + model + `clean{userPrompt,assistantOutput}`, rendered like a Claude turn. Send-time `/redact` passes `audit:false` (no duplicate row). Extension captures the reply via a settle-debounced MutationObserver (`readLatestResponse`) + `getModel()` — both selectors hit live on first try. Sends the RAW prompt to `/log-turn` (gateway redacts before store) so PII flag/counts are accurate; only redacted text persisted. |
| G-Resp2 — Response capture: text-change detection (2026-07-29) | ✅ Docs/Sheets/Slides live-verified | happy: Docs/Sheets/Slides reply captured (was empty) / short reply ("Hello! How can I help?") captured despite shape's 80-char floor / e2e 15/15 unaffected | ✅ e2e 15/15 | `content-main.js captureAndLogTurn` used to gate the selector read on `responseCount() > baseline` (a NEW node). The Workspace side panel streams the reply INTO an EXISTING bubble (count doesn't grow) → selector path skipped → shape fallback dropped short replies → **Docs logged empty response** even though `.appsElementsSidekickAgentMessageBubbleContent` resolved. Now `hasNewReply()` = new bubble OR latest-bubble TEXT changed vs a pre-send snapshot; selector path (no length floor) wins. `content-bridge.js` relays a `debug` config key for live tracing. **Docs/Sheets/Slides verified live 2026-07-29.** **Flake fix (same day):** capture was INTERMITTENTLY empty on the working apps — three races: (1) `hasNewReply` used node COUNT, which grows the instant the USER's own bubble is appended → on a slow reply the 2.5s settle fired before the model answered → empty; (2) `readLatestResponse` returned the bare LAST node even when it was a trailing empty placeholder/chip; (3) when the selector path was "new" but momentarily read empty it logged "" and never tried shape. Now: `readLatestResponse` returns the last NON-EMPTY node; a `readReply()` helper excludes the user's own prompt text; `hasNewReply` is TEXT-based (not count) so only a real model reply trips the settle; finish ALWAYS falls back to shape when the selector read is empty. **Live-confirmed across repeated turns 2026-07-29 — gemini/Docs/Sheets/Slides capture every turn, no more intermittent (none).** |
| G-Frames — all_frames + arming gate + sawComposer (2026-07-29) | ✅ Gmail redaction live-verified; Gmail/Chat/Drive reply capture NOT solved | manifest `all_frames:true` so the content script reaches the cross-origin `chat.google.com` **gtn-brain iframe** where Gmail/Drive host the Ask-Gemini composer / arming gate: only arm the top frame or a `chat.google.com` subframe (never stray ogs/relay/about:blank frames) / `sawComposer`: fail-closed blocks ONLY in a frame that has actually had a composer | ✅ e2e 15/15 | **Gmail composer is in the chat.google.com iframe** (top-frame `findComposer` fails → the "can't find composer" flood). Before `all_frames` that iframe was never injected. `all_frames` armed it — **Gmail send now redacts (token in the sent bubble, live-verified)**. Arming gate + `sawComposer` stop the top-`mail.google.com`-frame flood AND stop it blocking ordinary Enter/clicks (only a frame that has seen a Gemini composer fails closed). **Gmail/Chat/Drive REPLY capture still unsolved:** the reply renders in the TOP `mail.google.com` frame as an OBFUSCATED, rotating-class `div[role=listitem]` inside `div[role=list]`, interleaved with suggestion-chip `listitem`s (proved via right-click-Inspect: `host:mail.google.com`, ancestry `k3ABge[role=list] > NA2Vme[role=listitem]`). No stable selector; the reply is short + chip-ambiguous — the exact case `response-finder.js` deliberately returns "" for (a wrong prompt↔reply pairing is worse than none). Capturing it needs a dedicated top-frame reply watcher that pairs the last user bubble with the assistant `listitem` while rejecting chips — a focused follow-up, not a selector add. |
| G4 — Fail-closed tripwire | ✅ Done (ON by default) | happy: redacted body on Gemini endpoint not aborted / failure: raw PII on Gemini endpoint aborted (fetch+XHR) + blocked event / edge: non-Luhn digits + off-endpoint telemetry NOT aborted | ✅ 116/116 | `tripwire.js` rewritten: `luhnValid` (mirrors `src/redaction.ts`), `bodyLooksRaw` (Luhn-gated card), `shouldInspectUrl` + `DEFAULT_GEMINI_ENDPOINTS` (endpoint scoping — telemetry false-positive fixed), `extractUrl`, XHR `open`-wrap. ON by default (`config.tripwire:false` / `tripwireEndpoints` to override via storage). Endpoint list is live-tunable like the selectors — **confirm against the real Network tab**. `tests/phase-gemini-core.test.ts`. |
| G5 — Health check + live selector watcher (Layer 2) | 🟡 Watcher done; enterprise pending | detect-only canary: composer findable on gemini / warn (not fail) on closed Workspace panel / `--self-check` validates probe headlessly | ✅ self-check 2/2 | `scripts/selector-watch.mjs` (`npm run watch:selectors`) — Playwright `launchPersistentContext` over real surfaces, JSON report to `~/.secure-llm-gateway/selector-watch-report.json`, non-zero exit on hard break; `WATCH_SEND=1` deep-checks the wire is tokenized (reuses tripwire `shouldInspectUrl`). `selectorsHealthy()` + 15s poll in `content-main.js`. **Detect-only — no auto-patch (Layer 3 out of scope).** Admin-console force-install rollout not done. |
| G-Heal — Self-healing composer finder (Layer 1) | ✅ Done 2026-07-22 | happy: labelled composer beats small box / failure: no viable candidate → -1 / edge: zero-area Sheets decoy rejected, real composer picked | ✅ 116/116 + e2e 15/15 | `extension/src/composer-finder.js` (pure scorer: `scoreComposerCandidate`/`pickComposer`/`MIN_COMPOSER_AREA`, unit-tested). `findComposer` (`composer.js`) = **Gemini-specific** fast-path (generic catch-alls removed — they could return a wrong sane element) → heuristic fallback via `describeCandidate` + `pickComposer`. One scorer covers gemini.google.com + all Workspace apps. e2e `?dom=changed` scenario proves self-heal in real Chromium. Manifest `web_accessible_resources` +`composer-finder.js`. `tests/phase-gemini-core.test.ts`. |
| G-Learn — Focus/fingerprint self-learning (Layer 1.5) | ✅ Done 2026-07-22 | focus-wins: focused editable beats a bigger competing box / fingerprint: matches same box, rejects diff-tag decoy / recall: saved fingerprint picks box with no focus + heuristic fallback | ✅ 116/116 + e2e 15/15 | `extension/src/composer-learn.js` (pure: `makeFingerprint`/`scoreFingerprintMatch`/`chooseComposer`, unit-tested). Priority **focus > learned fingerprint > heuristic**. Focus = the box the user types in at submit (fixes "Case B" competing boxes); fingerprint (tag/role/aria/stable classes — **no PII**) persisted via bridge to `chrome.storage.local` (`learnedComposer`), restored into MAIN on load — recalls composer after a redesign with one learned submit. Safe realization of "auto-identify" (no leak, no blind selector-patch). e2e `?dom=ambiguous` proves focus-wins in real Chromium. Manifest +`composer-learn.js`. `tests/phase-gemini-core.test.ts`. |
| G-Reply — Selector-free assistant-reply capture (obfuscated panels) | ✅ Done 2026-07-29 (live per-surface check pending) | happy: streamed reply captured on a rotating-class panel, chip NOT logged (both anchor strategies) / failure: chips-only or no anchor → BLANK response, never a guess / edge: a previous turn's reply (and a hidden one) is never paired with this prompt | ✅ 8/8 (141/141) | `response-finder.js` (pure scorer) + `response-capture.js` (DOM walk, anchored on the submitted text, text-node fast path for Gmail-sized DOMs). Fixes Gmail/Drive/Chat showing "(none)" as assistant output; semantic selectors still run first so Gemini web/Docs/Sheets/Slides are unchanged. `CONFIG.settleMs`/`turnTimeoutMs` now tunable. Browser e2e `npm run test:gemini-response-e2e` (not run here — no chromium binary). `tests/phase-gemini-response.test.ts`, `WORKSPACE_COVERAGE.md` §5.7. |
| G-Workspace — Google Workspace side panel (Gmail/Docs/Sheets/Slides/Chat) | ✅ Live-verified 2026-07-21 | live: Docs + Gmail + **Sheets** + Chat network-proven (raw→zero matches; token in streamGenerate/create_message) / Enter-key path works (not just the ↑ arrow) / tripwire `shouldInspectUrl` covers `streamGenerate` | ✅ 116/116 + live | **Additive, gemini.google.com untouched.** `manifest.json` +Workspace hosts (mail/docs/drive/chat) in both match arrays; `composer.js` +`div[contenteditable][aria-label*="Ask Gemini" i]` selector (appsElements, NOT Quill — top-level DOM, not shadow/iframe); `content-main.js` `fireSubmit` now picks the **enabled+visible** send button (Workspace renders a **disabled decoy** `aria="Submit"` beside the real one) and dispatches a **full pointer sequence** (Gm3 Material buttons ignore a bare synthetic click); `tripwire.js` `DEFAULT_GEMINI_ENDPOINTS` +`streamGenerate`/`appsgenaiservice` (Workspace endpoint is lowercase, on appsgenaiservice host). **Selector-order fix (Sheets):** the `aria*="Ask Gemini"` selector must precede the generic `role=textbox`/`textarea` catch-alls in `composer.js` — Sheets' empty stray `role=textbox` boxes were hijacking `findComposer` → `readText`="" → send went out unredacted; reorder fixed it (Quill still first, gemini web unaffected). `content-main.js` has `CONFIG.debug` tracing in `onSubmitEvent` (off) that pinpointed it. Shared panel → one fix covers all five apps. **Drive: in manifest but still untested.** |
| X-Browser — Firefox port | ✅ gemini.google.com done; ⚠️ Workspace panels fail-closed | happy: real Firefox + real add-on + real gateway sends a redacted token, zero raw PII, exactly one send / failure: gateway unreachable → nothing sent + user told + no raw PII on the page / edge: MAIN-world module loads under a gemini-like `nonce`+`strict-dynamic` CSP, and background runs as an event page with no manifest warnings | ✅ 12/12 + 156/156 | `src/browser-api.js` (`chrome` before `browser` — `browser.*` is promise-only), `background.scripts` event page (no MV3 SW, bug 1573659), `cloneInto` for Gecko compartment isolation, config re-publish race fix. Harness: `firefox-rdp.mts` + `firefox-marionette.mts`. **gemini.google.com live-verified 2026-07-30** (redaction + real-reply capture, 3 turns, = Chrome). **FIREFOX WORKSPACE-PANEL LIMITATION (found live 2026-07-30):** in the Docs/Sheets/Gmail/Drive/Chat "Ask Gemini" panels (a plain Angular contenteditable, not Quill) Firefox does not sync our redacted `writeText` into Gemini's model — it XHRs the RAW PII, the **G4 tripwire aborts it** (`tripwire: raw PII in outgoing XHR body — aborting`), Gemini shows "Something went wrong". **NO LEAK — fail-closed holds**, but a PII message can't be sent from a Firefox Workspace panel (non-PII messages work). A `beforeinput`/`input`-rewrite of `writeText` was tried and did NOT make the Firefox Workspace model sync; reverted rather than ship an unproven change on the redaction path. gemini.google.com (Quill) unaffected. Chrome Workspace panels unaffected. |
| P — ChatGPT surface (chatgpt.com) | ✅ Done 2026-07-30 — **live-verified in Chrome AND Firefox (all 14 rules on the wire)** | happy: token on the wire from a ProseMirror composer, exactly one send + one `/redact`, turn logged `openai`/`chatgpt-web-extension` with model + reply / failure: gateway down ⇒ blocked, and a DESYNCED editor ⇒ tripwire abort (no raw PII) / edge: host scoping — a Gemini `ql-editor` decoy on the page never wins, a `<textarea>` is never the composer target, ChatGPT endpoints don't inspect Gemini's and vice-versa | ✅ 8/8 (161/161) + e2e 17/17 | **Zero gateway change; Gemini path functionally untouched.** New `extension/src/site-adapter.js` = hostname-keyed selectors/endpoints/log-labels; `composer.js`/`content-main.js`/`tripwire.js` are now site-agnostic. Logs as `provider:"openai"` (FROZEN enum untouched). **The ProseMirror write was proven on the live wire BEFORE building** — the existing `execCommand("insertText")` syncs; the hidden companion `textarea` and a synthetic `paste` both ship raw (see § note). `tests/phase-chatgpt.test.ts`, `npm run test:chatgpt-e2e`, `extension/CHATGPT_COVERAGE.md`. **Firefox works too** — the reported Firefox breakage was a stale `extension/build/firefox` (host not matched ⇒ unprotected, not fail-closed), now guarded by a staleness test in `tests/phase-cross-browser.test.ts`; CSP + ProseMirror-sync both probed clear on the real page (`probe:firefox-chatgpt`). |
| Q — File-upload guard (ChatGPT) | ✅ Live-verified 2026-07-30 | happy: a PII text file uploads as tokens, no raw PII, page keeps the original filename / failure: an unscannable PDF and a gateway-down text file are never uploaded + the user is told why / edge: a clean file's bytes are unchanged, and a raw upload that bypassed the DOM guard is aborted by the tripwire | ✅ 4/4 unit (166/166) + chatgpt e2e 31/31 | Probe-driven (`upload-probe-console.js`, metadata only): bytes leave at **ATTACH time, ~19s before send**, as an XHR PUT of the `File` to a **region-specific** `*.oaiusercontent.com` host. `src/upload-core.js` (pure) + `src/upload-guard.js` (capture-phase kill-and-re-fire, clears the input) + tripwire backstop (defers `send()` for the async Blob read). **Unscannable formats BLOCKED** — so a pasted screenshot is blocked, intended. Binary extension beats a text MIME type. **Live-verified on real chatgpt.com:** the 14-type sample uploaded as placeholder tokens (ChatGPT said so itself), exactly one upload per attach, Initiator `tripwire.js:209`; a PDF carrying PII was refused with `binary-extension` and never uploaded. **Gemini uploads probed + armed 2026-08-03** — Blob POST to `push.clients6.google.com/upload/` (attach-time, guard-supported shape); endpoint pinned to `clients6.google.com`+`/upload/`. Covers gemini.google.com; the Workspace-panel upload endpoint is still unprobed, so the attach-time guard scrubs there but the wire backstop doesn't yet cover it. `tests/phase-upload.test.ts`, `extension/CHATGPT_COVERAGE.md` §6. |
| R — Office-file scrubbing (zip+XML) | ✅ Live-verified 2026-07-30 (synthetic docx; real Word doc untried) | happy: PII split across Word runs is concatenated, redacted and written back / failure: XML entities survive the round trip, and a redaction that doesn't line up paragraph-for-paragraph THROWS instead of scattering text / edge: only text-bearing parts are touched, legacy .doc/.xls/.ppt stay blocked, and the rebuilt archive passes the system `unzip -t` | ✅ 7/7 (173/173) + chatgpt e2e 36/36 | DOCX/XLSX/PPTX are ZIP+XML, so `DecompressionStream`/`CompressionStream` (built-ins) make a real SCRUB possible — the file is cleaned and sent, not refused. `src/zip.js` + `src/ooxml.js`. Word splits words across runs, so text is concatenated **per paragraph** before scanning; only changed paragraphs are rewritten. Paragraphs join with NUL (illegal in XML ⇒ unambiguous split). Also added `uploadPolicy:"warn"` escape hatch (upload + `unchecked` audit row at attach time) with `block` still the default. **Live-verified on real chatgpt.com:** ChatGPT reported placeholders for the email/SSN/card (all split across runs) with the clean paragraph unchanged — and its own parser read our REBUILT archive. **Still untried: a document straight out of Word/Google Docs.** `tests/phase-ooxml.test.ts`, `extension/CHATGPT_COVERAGE.md` §6.1b. |
| S — Grok surface (grok.com) | ✅ Done 2026-07-31 — **live-verified on real grok.com (Chrome), all 14 rules on the wire via the mouse-click send path** | happy: token in the `message` field on the wire from a Tiptap/ProseMirror composer, exactly one send + one `/redact`, turn logged `openai`/`grok-web-extension` with the tier model and a reply recovered by SHAPE / failure: gateway down ⇒ blocked, and a DESYNCED editor ⇒ tripwire abort (no raw PII) / edge: host scoping — a Gemini `ql-editor` decoy never wins, `<textarea>` is never the composer, x.com is not claimed, Grok/ChatGPT/Gemini endpoint lists don't inspect each other, and clicking Grok's UNLABELED submit button is still intercepted | ✅ 5/5 (178/178) + e2e 21/21 | **Zero gateway change; adapter-only apart from ONE shared-code fix.** Grok = Tiptap = ProseMirror, so ChatGPT's proven `execCommand` write is reused as-is. New `GROK_ADAPTER`; logs `provider:"openai"` + `source:"grok-web-extension"` (FROZEN enum untouched). The shared-code fix: Grok's send button is an **unlabeled `button[type="submit"]`**, so `content-main.js` now UNIONs the site's `liveSendSelector` into the click filter — without it a click sends raw, the tripwire aborts, and the message silently fails (fail-closed, not a leak; confirmed by reverting the fix). `responseSelectors` deliberately **empty** ⇒ shape-based capture. **LIVE-VERIFIED 2026-07-31:** all 14 rules tokenised in one turn sent BY MOUSE CLICK, Grok itself reported the fields "were already redacted before they reached me", and a cross-request search for the raw address across 159 requests found nothing. Firefox on Grok still untried. `tests/phase-grok.test.ts`, `npm run test:grok-e2e`, `extension/GROK_EXTENSION.md`. |
| T — DeepSeek surface (chat.deepseek.com) | ✅ Done 2026-08-03 — **fully live-verified (text + upload scrub + label)** | happy: chat.deepseek.com resolves to the DeepSeek adapter, tier label → log slug, a turn logs `openai`/`deepseek-web-extension` with only redacted text / failure: a READABLE raw body on `/chat/completion` is aborted (mechanism wired) + the composer selectors target a `<textarea>` and never a contenteditable / edge: the four surfaces share no selectors or endpoint fragments, reply read by `.ds-markdown`, upload guard ARMED (probed FormData POST to `/file/upload_file`, telemetry excluded) | ✅ 5/5 (188/188) | **Adapter-only — ZERO shared-code change** (the first surface needing none: the textarea write path already existed for the Workspace composers). The EASIEST composer — probed live as a plain `<textarea>` (`isTextarea:true`, no ProseMirror/Lexical) — so `writeText`'s native-setter+input path handles it. The WEAKEST backstop: DeepSeek **ENCRYPTS the request body** (WASM proof-of-work — a Network search for the typed text found NOTHING, `create_pow_challenge`+`sha3_wasm` present), so the **tripwire is BLIND** on this surface (it can't read ciphertext). Redaction still holds — the textarea is scrubbed before DeepSeek encrypts it — but the fail-closed net can't verify the wire, so the **primary intercept is the sole protection** and the live textarea-write check is MANDATORY before trusting it. Send endpoint `POST /api/v0/chat/completion` (tripwire fragment `/chat/completion`, survives the `/completions` plural). Reply via `.ds-markdown` + shape fallback. Logs `provider:"openai"` + `source:"deepseek-web-extension"` (FROZEN enum untouched). **Live verification on real chat.deepseek.com still pending.** `tests/phase-deepseek.test.ts`, `extension/DEEPSEEK_EXTENSION.md`. |
| S-Upload — Grok file-upload guard | ✅ Done 2026-07-31 — **LIVE-VERIFIED on real grok.com (text + `.docx` scrubbed, PDF refused)** | happy: a PII text file is uploaded as tokens in a multipart body, no raw PII, page keeps the filename, and the `File` the page is HANDED is already redacted (so no raw copy ever exists for it to send) / failure: an unscannable PDF (text MIME, binary extension) and a gateway-down text file are never uploaded + the user is told why / edge: a clean file's bytes are unchanged, and a raw MULTIPART upload that bypassed the DOM guard is aborted by the tripwire | ✅ 5 unit (183/183) + grok e2e 67/67 (46 new: upload, drag-and-drop, mixed multi-file, `uploadPolicy:"warn"`) + chatgpt e2e 36/36, gemini 15/15, response 8/8 unchanged | Probed first (§ note above): bytes leave **35ms after attach** (ChatGPT: 259ms), ~24s before the send, as **multipart FormData** POSTed with **fetch** to `grok.com/http/upload-file-v2/direct` — same-origin, so no region-suffix trick needed. **The attach-time DOM guard needed no change** (it swaps a redacted `File` into `input.files`, and the page builds its own body from that). Two backstop gaps closed: `isBinaryBody` (Blob-only) → `uploadBlobsOf` which unpacks multipart and returns **all** file parts; and the backstop existed on **XHR only**, so Grok's fetch upload had no wire-level net at all — `tripwire.js` gained a fetch branch. An e2e false pass was caught en route (fixture posted to a relative path ⇒ `{host:"grok.com"}` never matched ⇒ the bypass test "passed" without exercising the backstop). `tests/phase-upload.test.ts`, `npm run test:grok-e2e`. **Live-verified on real grok.com 2026-07-31 and it is the strongest upload evidence yet — Grok printed both files back verbatim rather than summarising:** `pii-sample.txt` came back with **all 14 rules fired** ("All the sensitive values appear to be redacted"), and `upload-office-test.docx` came back with the email/SSN/card (each **split across Word runs**) redacted and the clean paragraph unchanged — so **xAI's parser also read our REBUILT archive**, a second independent consumer after OpenAI's. A PDF could not be attached at all (`binary-extension`), as intended. **Drag-and-drop coverage added 2026-07-31 (grok e2e 46/46) — the first automated drop coverage on ANY surface**, incl. the re-fired `DragEvent` having to bubble back to the page's handler; mutation-checked by neutering the drop listener (6/10 fail). That check also proved the tripwire independently aborts a raw *text* drop, but **cannot** see a real binary PDF, so the attach-time guard remains the only defence for unscannable formats. **Drop then LIVE-VERIFIED on real grok.com in Chrome the same day — the first live drop check on Chrome on any surface** (ChatGPT's was Firefox-only): a file dragged in from Finder came back with all 14 types tokenised, which is the part the harness cannot prove (its `DragEvent` is page-constructed, not a trusted OS drag). **A mixed `.txt`+`.docx` attach was live-verified the same day** and is now covered too — the two kinds take different reassembly branches (rebuilt `File` vs replacement text), plus order preservation and all-or-nothing. That test had to `readZip` the uploaded archive: grepping the deflated body as text would have passed even on an unscrubbed docx. |
| X-Browser — Safari port | ⚠️ Packaged, NOT verified | n/a — could not build or run | n/a | `npm run ext:build:safari` produces the package, but `xcrun safari-web-extension-converter` needs full Xcode (only CLT installed here), so **loopback fetch is unverified**. Safari-specific choices already made: event page only (MV3 SW enforces CORS on extension fetches), scheme-based extension origin (GUID rotates), `storage.managed` → `local`. Needs: App Sandbox network-client entitlement + macOS Local Network permission. Fail-closed intact if loopback is blocked. |
| PG2 — Prompt guard: Cursor delivery (Build 2) | ✅ Done 2026-08-06 | risky prompt via `POST /prompt-guard` ⇒ `inject` + a `cursor-hook` security-log entry (raw prompt, `provider:cursor`) / classifier throws ⇒ endpoint FAILS OPEN (HTTP 200 `allow`, logs nothing, no crash) / `.cursor/rules` generator is source-of-truth-faithful (every `guidance.ts` template + prefix in the `.mdc`) + benign prompt logs nothing | ✅ 16/16 (217/217) | **Build 2 = the second surface.** Cursor traffic is NOT on the gateway wire, so delivery is: (a) static `.cursor/rules/security-safety-guidance.mdc` generated FROM `src/guidance.ts` (`scripts/gen-cursor-rules.ts`, `npm run cursor:rules`) — the INJECTION path, always-applied, can't be skipped; (b) `scripts/cursor-prompt-guard-hook.mjs` on `beforeSubmitPrompt` (**fail-OPEN**, log + severe-block only — Cursor's hook is block-only, can't add context) POSTs to new loopback-gated `POST /prompt-guard` which runs the SAME `analyze()` + logs to `securityLog` as `surface:cursor-hook`. Tier-2 reuses the gateway's OWN configured Anthropic key (no per-request auth on this surface; no key ⇒ Tier-1 only). Wired into `gateway-service.mjs configure-cursor` (2nd `beforeSubmitPrompt` entry, non-failClosed; refreshes `.cursor/rules` on configure). **LIVE-VERIFIED on real Cursor Agent 2026-08-06 via A/B rules test:** moved `.cursor/rules/security-safety-guidance.mdc` out, quit+reopen Cursor, re-asked the SQL-concat prompt — with rules PRESENT the Agent refused to emit the vulnerable concat code and stated *"Checking the project's security guidance so the response matches how we handle it"* ("Explored 1 search"); with rules REMOVED the Agent wrote the unsafe f-string pattern (labeled) with no guidance mention. The `.cursor/rules` injection path is proven on the live Agent; file restored + confirmed == source of truth. (The `beforeSubmitPrompt` hook / `POST /prompt-guard` log-path remains hermetic-only.) `tests/phase-prompt-guard.test.ts`. |
| CG2b — Code guard (Checkpoint 2b): generated-code correct/regenerate | ✅ Done 2026-08-07 | happy: SQL-concat file scanned ⇒ sql_injection finding accumulates, `/pending` returns then CLEARS / failure: guard OFF ⇒ no findings, unreadable body ⇒ 200 empty never blocks (fail-SAFE) / edge: Tier-1 MISSES missing-auth route but Tier-2 records it (tiers run independently) + loud audit row **+ 2 hooks: Stop hook honors `stop_hook_active` (exit 0, no call) + fails safe on unreachable gateway** | ✅ 14/14 (245/245) | **Ships DARK** (`GATEWAY_ACTION_GUARD=on`, default off). Two-tier `scanCode` (Tier-1 patterns ‖ Tier-2 LLM, both unconditional, merged); Tier-2 reuses request's own Anthropic auth. **FAIL-SAFE** (inverse of CG1) — code on disk, nothing to block. Per-`conversation_id` accumulator (`src/action-guard-store.ts`), `POST /action-guard/scan` + `GET /action-guard/pending`, 3 hooks. `securityLog` `kind:"action-guard"` (metadata only, no raw code). Hermetic only (Tier-2 via `setCodeScanner` seam; no live shell-hook verify). Cursor `stop`/regenerate + cap `block` path + admin surfacing deferred. `tests/phase-action-guard.test.ts`. |
| CG1 — Command guard (Checkpoint 2 v1): shell-command prevent | ✅ Done 2026-08-07 | enabled: `rm -rf` deny + logged, `ls` allow + not logged, `git push --force` ask / fail-CLOSED: unreadable body ⇒ deny, guard OFF ⇒ allow / edge: `--force-with-lease` not flagged, deny row stores raw command + matched pattern **+ hook: Claude Code hook denies + exits 0 (not fail-open exit 1) when gateway unreachable** | ✅ 10/10 (230/230) | **Ships DARK** (`GATEWAY_COMMAND_GUARD=on`, default off). Zero-dep deterministic `classifyCommand` (`src/command-rules.ts`): deny destructive / ask git-history-rewrite / allow. **FAIL-CLOSED** — inverse of prompt-guard; `/command-guard` denies on any error; Claude Code hook self-denies (platform default is fail-OPEN). Cursor `beforeShellExecution` (`failClosed:true`, wired only when on) may still be ignored on sandbox/allow-list ⇒ best-effort + always-logged. `securityLog` `kind:"command-guard"`. Code-scan "correct" half deferred to CK2b. PRD `checkpoint2.md`, spec `CHECKPOINT2_ACTION_GUARD.md`. Hermetic only (no live shell-hook verify yet). `tests/phase-command-guard.test.ts`. |
| PG1 — Prompt guard: analyzer + Claude Code inject | ✅ Done 2026-08-05 | risky prompt ⇒ guidance in `system[]` + user message byte-identical / classifier throws ⇒ fail-OPEN (forwarded, no guidance, no crash) / existing `system[]` preserved (no-clobber) + raw-prompt log separation (metadata log redacted, security log raw) | ✅ 12/12 (212/212) | **Checkpoint 1, Build 1. Ships DARK** (`GATEWAY_PROMPT_GUARD=on`, default off). **Inverted two-tier** (design 2026-08-05): Tier-1 is a benign-SKIP filter, not a keyword gate (closes the keyword-less-manipulation blind spot); Tier-2 LLM classifier is MANDATORY for safety, reuses the request's OWN Anthropic upstream+auth (no new key), Anthropic-only in v1. **FAIL-OPEN** — the deliberate inverse of PII redaction; a miss = no guidance, never a dropped request. Never edits user message text (guidance → `system[]` only). New `src/prompt-analyzer.ts` + `guidance.ts` (single source of truth for both surfaces) + `prompt-classifier.ts` + `security-log.ts`; inject in `proxy.ts` before inbound scrub; `LogEntry.analyzer` metadata + admin-gated `GET /security-log` raw store. Cursor delivery = **Build 2** (`.cursor/rules/` from `guidance.ts` + `beforeSubmitPrompt` hook for log/severe-block — hook verified block-only, cannot add context). `tests/phase-prompt-guard.test.ts`. |
| U — Admin dashboard (control plane) | ✅ Done 2026-08-04 — zero-dep; **login + 8 tabs live-verified in Safari**; enforcement wired (extension reads /internal/config; live block-check pending) | auth: seeded admin logs in + JWT opens a protected route / wrong password 401 + 6th attempt/min rate-limited (429) / tampered + expired JWT rejected. events: `/internal/events`→analytics / malformed body still 202, never blocks / **no raw PII persisted** — a value sneaked into `pii_types` is dropped. controls: surface mode PUT→`/internal/config` + audit row / **Cursor→redact 400** (block/allow only) / audit append-only, disabled surface reflected | ✅ 9/9 (197/197) | **Zero runtime deps** (rejected the prompt's React/Vite/Tailwind/recharts/bcrypt/npm-sqlite stack — violates §2). `node:sqlite` DB, `node:crypto` scrypt + HMAC JWT (8h), server-rendered HTML + inline-SVG dashboard mirroring `console.ts`. New `src/admin-{store,auth,api,console}.ts` + `scripts/admin-seed.ts`. Wired into the EXISTING process: `GET /admin` + `/admin/api/*` (JWT) + `/internal/*` (loopback) in `server.ts`; a single `trafficLog` `onPush` listener (`traffic-log.ts`) emits one analytics event per decision (**metadata only** — surface/decision/PII-type-names/latency) so every already-logging surface lights up with no decision-site edits. Global PII-type toggle drives the live engine (`setRuleEnabled`). `adminEnabled` defaults OFF under `--test` so unrelated test servers don't touch the real `~/.secure-llm-gateway/admin.db`. Run: `npm run admin:seed` then `http://127.0.0.1:8001/admin`. **8 tabs**: Analytics, AI Controls, Rules, Allowlist, Model Policy, Traffic, Try Redaction, Audit — the console-mirror tabs reuse `handleControlApi`/traffic-log/`redactText` behind the JWT (console mutations audited). **ENFORCEMENT WIRED (2026-08-04):** the extension SW serves `GET /internal/config/:surface` to `content-main.js`, which on a real send enforces the admin policy BEFORE redacting — `mode:block`/disabled ⇒ block ALL sends on that site (gemini web+Workspace / chatgpt / grok / deepseek), `mode:off` ⇒ raw allowed, `redact` ⇒ normal; polled ~15s. Claude Code/SDK restricted via Model Policy (proxy 403). Analytics already covers every surface (proxy + each `/log-turn` push feeds the listener). `tests/phase-admin.test.ts` (12), `ADMIN_DASHBOARD.md`. |


**Status legend:** ⬜ Not started · 🟡 In progress · 🔴 Tests red (gate closed) · ✅ Done (gate green)

**How to update this ledger:** when a phase's gate goes green, set its row to ✅, fill in the
three test names, mark suite green, bump *Last updated* and *Current phase*, and adjust the
*Overall* count. When you start a phase, set it 🟡. When tests are failing, set 🔴 so the
closed gate is visible. Never advance *Current phase* past a row that isn't ✅.