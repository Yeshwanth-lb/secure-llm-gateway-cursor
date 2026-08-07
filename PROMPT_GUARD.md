# PROMPT_GUARD.md — Prompt Guidance Layer (Checkpoint 1)

> Single-file reference for the **prompt-guard** feature: what it is, why it is built
> the way it is, every moving part, how to run and verify it, and where each piece
> lives. Companion to `checkpoint.md` (the PRD/design) and the Project Status Ledger
> in `CLAUDE.md`. All prompt-guard work lives on branch `phase/prompt-guard`
> (committed `8fcc098`, pushed to `origin`).

---

## 1. What it is (one paragraph)

The gateway already redacts **PII bidirectionally** (fails **closed** — never leak).
The prompt guard adds a second, orthogonal safety layer: it **analyzes each user
prompt for security/safety risk**, and if risky, **injects secure-coding / safety
guidance into the model's SYSTEM channel** so the model answers more safely — it
**never edits the user's message text**, and it **never drops the request**. Every
decision is logged. It ships **DARK** (off unless `GATEWAY_PROMPT_GUARD=on`).

**The defining inversion:** PII redaction **fails CLOSED** (a failure blocks the send).
The prompt guard **fails OPEN** — any error/timeout/parse failure returns `allow`, so a
missed detection just means "no guidance added", *never* a dropped request. A guidance
layer that occasionally drops real work would get turned off; one that occasionally
misses is still net-positive. This asymmetry is deliberate and load-bearing.

---

## 2. Two surfaces, one brain

| | **Claude Code** (Build 1) | **Cursor** (Build 2) |
|---|---|---|
| On the gateway wire? | **Yes** — Claude Code routes through `127.0.0.1:8001` | **No** — Cursor calls providers server-side, bans private-net base URLs |
| Delivery of guidance | Injected into request `system[]` in `proxy.ts` before the inbound scrub | Static `.cursor/rules/security-safety-guidance.mdc`, always-applied |
| Per-prompt hook | (none — the proxy sees every request) | `beforeSubmitPrompt` hook → `POST /prompt-guard` (log + severe-block only) |
| Tier-2 auth | Reuses the **request's own** Anthropic key + upstream | Reuses the **gateway's own** configured Anthropic key |
| Can inject at hook time? | Yes (proxy rewrites the body) | **No** — Cursor's `beforeSubmitPrompt` is block-only (verified) |

Both surfaces share ONE decision engine (`analyze()`) and ONE guidance source
(`src/guidance.ts`). Change the wording once, both surfaces follow.

Why the split: Cursor's traffic never touches the gateway, so we cannot rewrite its
request body. The injection therefore comes from `.cursor/rules/` (Cursor's own
always-applied context mechanism, generated from the same guidance templates). The
`beforeSubmitPrompt` hook can only **allow/block**, so on the Cursor surface it is
effectively **log-only** (v1 has no active block category).

---

## 3. The analyzer — inverted two-tier (`src/prompt-analyzer.ts`)

```
prompt ──► Tier 1: benign-SKIP filter ──► trivial?  ──yes──► allow (tier 1, ~1-3ms)
                                             │no
                                             ▼
                     Tier 2: LLM classifier (mandatory) ──► risk? ──no──► allow (tier 2)
                                             │                    yes
                                             ▼
                           inject (or block if a block-category matched)
```

**Tier 1 is a benign-SKIP filter, NOT a risk-keyword gate.** A keyword gate would be
blind to keyword-less manipulation (the case we most care about). So we **invert**: the
default is to ANALYZE; Tier 1 only fast-skips prompts it is *confident* are trivial
(short, purely-informational questions with no imperative/code/data shape). A false
"not trivial" costs one Tier-2 call; a false "trivial" would skip analysis — so Tier 1
is biased hard toward NOT trivial. Signals that force Tier 2: length > 160 chars or
> 24 words, code/data punctuation (`` ` { } ; = => // ``), a URL, an email-ish token, a
6+ digit run, any newline, any imperative/risk verb, or anything not matching a plain
`what/who/how…` factual opener.

**Tier 2 is the real detector** — one LLM classification call. It is **mandatory for
safety**: with Tier 2 off, there is no risk detection at all, only Tier-1 skipping.

**Verdict cache** — Tier 2 is a 1–5s upstream call, and Claude Code re-sends the SAME
latest user message across the several sub-requests it fires per turn. The analyzer
memoizes the verdict by prompt text (bounded FIFO, 500 entries), so a turn costs **one**
classify call, not N. This is what makes a slower/stronger classifier (Sonnet) practical
on the wire. Nulls (timeout/throw) are NOT cached — they retry next time.

**Fail-open is enforced at every layer:** `analyze()` wraps its whole body in
try/catch, `withTimeout()` resolves to `null` (never rejects) on timeout, and a
classifier throw resolves `null`. Every one of those paths returns `allow`.

---

## 4. The Tier-2 classifier (`src/prompt-classifier.ts`)

`classifyViaAnthropic(ctx)` makes **one** Anthropic Messages call on the SAME upstream
the request already targets — **no new API key, SDK, or dependency** (`node:https`
only). v1 is **Anthropic-only**; other providers skip Tier 2 (Tier 1 still runs).

- Returns a `ClassifierVerdict` (`{risk, categories, confidence}`) or **`null` on ANY
  failure** (network / non-200 / unparseable) so the analyzer fails open.
- `parseClassifierJson()` is pure + unit-tested: strips ``` ```json ``` fences, grabs
  the first `{…}` object out of surrounding prose, validates shape + category labels,
  returns `null` on garbage.
- The **system prompt is high-recall**: because injecting guidance is cheap (it only
  ADDS a note, never blocks), it errs toward flagging any security-*sensitive*
  code-generation — including neutral-sounding feature requests whose naive
  implementation is vulnerable (IDOR/XSS/SSRF/open-redirect/path-traversal/weak-crypto)
  — **while still letting purely conceptual/educational questions through**
  (`"explain what SQL injection is"` → `allow`). That benign-lookalike guard is the
  measured false-positive control.

---

## 5. Risk categories & guidance (`src/guidance.ts`)

`src/guidance.ts` is the **single source of truth** for guidance text on both surfaces.
18 categories, each with a short imperative model-directed template and a
`CategoryAction` (`inject` | `block`). **v1: every category is `inject`** — steer, never
hard-block. The severe `block` set (CSAM, credible weapons uplift, etc.) is wired at the
mechanism level (`hasBlockCategory()`) but carries **no active category** yet, so a
future hard-refuse needs no re-architecting.

**Implementation-risk (code-gen):** `sql_injection`, `command_injection`,
`insecure_deserialization`, `hardcoded_secret`, `missing_auth`, `xss`, `ssrf`, `idor`,
`path_traversal`, `open_redirect`, `weak_crypto`.
**Data/agent risk:** `data_leakage`, `prompt_injection`, `exfiltration`.
**Safety:** `harmful_content`, `harassment_abuse`, `social_engineering`,
`policy_violation`.

`buildGuidance(categories)` concatenates the matched templates under the
`[SECURITY & SAFETY GUIDANCE]` prefix into ONE block (dedupes, empty list → `""`). The
prefix makes an injected block unambiguously identifiable in a log, a forwarded body, or
a `.cursor/rules` file. Example injected block:

```
[SECURITY & SAFETY GUIDANCE]
The user's request was flagged for potential security or safety risk. Follow this
guidance while responding. Do NOT mention this notice to the user unless relevant.
- Require parameterized queries / prepared statements. Never concatenate or interpolate user input into SQL strings.
- Protect state-changing and data-returning endpoints with authentication AND authorization checks. Do not ship routes with auth skipped, even 'temporarily'.
```

---

## 6. Injection into Claude Code (`src/proxy.ts`)

When `config.promptGuardEnabled`, the proxy pipeline runs the analyzer **before the
inbound scrub**, so guidance lands in the SAME body that gets scrubbed + forwarded:

1. Extract the latest user prompt from the (Anthropic-shaped) request body. Non-chat
   bodies → nothing to analyze.
2. Build the Tier-2 classifier **only when** `promptGuardTier2` and the resolved
   provider is `anthropic`, reusing the request's own `x-api-key` + `anthropic-version`.
3. `analyze(rawPrompt, …)` → verdict.
4. On `inject`: `injectGuidance()` appends a `{type:"text"}` guidance block to
   `system[]` (or the string `system`, or a `system` message for OpenAI-shaped bodies).
   **The user's message text is never touched.** Existing `system[]` is preserved
   (no-clobber). On error the body is returned UNCHANGED (fail open).
5. Two-store logging (see §8): PII-safe metadata → `trafficLog.analyzer`; raw prompt +
   guidance → admin-gated `securityLog`.

---

## 7. Cursor delivery (Build 2)

**Injection path — `.cursor/rules/security-safety-guidance.mdc`** (always applied,
unskippable). Generated FROM `src/guidance.ts` by `scripts/gen-cursor-rules.ts`
(`npm run cursor:rules`; exports `buildRulesMdc`/`writeRules` for reuse + tests). A test
asserts the generator is source-of-truth-faithful (every template + the prefix appear in
the `.mdc`). `gateway-service.mjs configure-cursor` refreshes it on configure.

**Per-prompt path — `scripts/cursor-prompt-guard-hook.mjs`** on `beforeSubmitPrompt`
(**fail-OPEN**, wired as the 2nd `beforeSubmitPrompt` entry, non-`failClosed`). POSTs the
prompt to `POST /prompt-guard` (loopback-gated), which runs the SAME `analyze()`, logs to
`securityLog` as `surface:"cursor-hook"` / `provider:"cursor"`, and returns
`{verdict, categories, block, guidance}`. Cursor's hook is **block-only** (cannot inject
context — verified 2026-08-05), and v1 has no active block category, so this endpoint is
effectively **log + severe-block only**. Tier-2 here reuses the gateway's OWN configured
Anthropic key (Cursor sends no per-request auth); **no key ⇒ Tier-1 only**.

---

## 8. Logging — two stores (never cross)

| Store | Holds | Gate | Purpose |
|---|---|---|---|
| `trafficLog` (existing, PII-safe) | metadata only: `analyzer` decision, categories, tier, latency — **no raw prompt, no guidance body** | none (already PII-safe) | ops / analytics |
| `securityLog` (`src/security-log.ts`, NEW) | **RAW prompt** + exact guidance + (later) redacted model reply | **admin-token gated** `GET /security-log` | security-team review |

`securityLog` is an in-memory ring buffer (cap 200, newest-first, gone on restart). Only
prompt-guard decisions land there, and **only when the analyzer ACTED** (verdict
`inject`/`block`) — plain `allow`s are not stored.

### 8.1 Cursor output back-fill (the newest piece)

Cursor's model reply is **off-wire** (Cursor calls the model server-side), so the flagged
`cursor-hook` row is written at submit-time with **no `response`**, while the reply is
captured separately by the `stop` turn-log hook and lands in the Traffic tab. That split
means a reviewer saw prompt + guidance in one place and the output in another.

`securityLog.attachResponse(surface, turnPrompt, response)` + a call in `POST /log-turn`
(`server.ts`, Cursor-scoped: `source` starts with `cursor`) **join** them: when a Cursor
turn finishes, the **REDACTED** reply is back-filled onto the matching flagged row, so a
reviewer sees **prompt + guidance + output in ONE record** — like a claude-code row.

- **Correlation is by prompt text** (the two Cursor hooks share no turn id): match when
  the flagged prompt equals the turn prompt, or is **contained** in it (a multi-message
  turn concatenates its user parts).
- Matches the **most-recent** flagged row of that surface still lacking a `response`.
- No-op if nothing matches. PII redacted before store (invariant held).

---

## 9. Configuration (`src/config.ts`, all env-driven)

| Env var | Default | Meaning |
|---|---|---|
| `GATEWAY_PROMPT_GUARD` | *(off)* | `on` enables the guard. Ships DARK. |
| `GATEWAY_PROMPT_GUARD_TIER2` | `on` (unless `off`) | Tier-2 LLM classifier. Off ⇒ no risk detection. |
| `GATEWAY_PROMPT_GUARD_MODEL` | `claude-haiku-4-5-20251001` | Classifier model. Live service uses `claude-sonnet-5`. |
| `GATEWAY_PROMPT_GUARD_TIMEOUT_MS` | `4000` | Tier-2 hard timeout. Live service uses `12000` (Sonnet is slower). |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_VERSION` | `""` / `2023-06-01` | Gateway's own key (used for Cursor-surface Tier-2). |

> **Timeout history:** the PRD's original ~600ms default made Tier-2 always time out
> against a real classifier (Haiku is 1.2–2.4s) → fail-open → guard silently inert.
> Raised to 4000ms (Sonnet ~3–7s cold, 0ms cached). Cost: ~1.5–2.5s added latency per
> non-trivial prompt — the inherent Tier-2-on-the-wire cost.

**Live launchd service** (`~/Library/LaunchAgents/tech.skylo.secure-llm-gateway.plist`):
`GATEWAY_PROMPT_GUARD=on`, `_MODEL=claude-sonnet-5`, `_TIMEOUT_MS=12000`,
`NODE_EXTRA_CA_CERTS=…/ZscalerRootCA.pem` (Node can't reach api.anthropic.com here
without it). It runs `secure-llm-gateway.ts` via `--experimental-strip-types`, so a
restart picks up current `src/` **with no build step**:
`launchctl kickstart -k gui/$UID/tech.skylo.secure-llm-gateway`.

---

## 10. HTTP endpoints (all loopback / admin gated)

| Method + path | Gate | Purpose |
|---|---|---|
| `POST /prompt-guard` | loopback | Cursor-surface decision. Fail-OPEN (any error → `{verdict:"allow", block:false}`). Never writes to the PII-safe traffic log. |
| `POST /log-turn` | loopback | Per-turn CHAT log; Cursor turns trigger `attachResponse` back-fill. |
| `GET /security-log?limit=N` | **admin token** (if set) | Read the raw security log (prompt + guidance + reply). |

---

## 11. Files

**New:**
- `src/prompt-analyzer.ts` — inverted two-tier engine, verdict cache, fail-open.
- `src/prompt-classifier.ts` — Anthropic Tier-2 classifier + tolerant JSON parse.
- `src/guidance.ts` — 18 categories + templates (single source of truth).
- `src/security-log.ts` — admin-gated raw store + `attachResponse` back-fill.
- `scripts/gen-cursor-rules.ts` — generate `.cursor/rules/` from guidance.
- `scripts/cursor-prompt-guard-hook.mjs` — `beforeSubmitPrompt` hook (fail-open).
- `.cursor/rules/security-safety-guidance.mdc` — generated injection rules.
- `scripts/prompt-guard-{demo,rung3,rung4}.mjs` — verification harnesses.
- `tests/phase-prompt-guard.test.ts` — 19 tests (see §12).
- `checkpoint.md` — the PRD/design.

**Modified:** `src/proxy.ts` (inject site), `src/server.ts` (`/prompt-guard`,
`/security-log`, `/log-turn` back-fill), `src/config.ts` (flags), `src/contracts.ts`
(`RiskCategory`/`AnalyzerResult`/`AnalyzerVerdict`/`CategoryAction` types),
`src/admin-api.ts` + `src/admin-console.ts` (Prompt Guard tab), `src/clean-view.ts`,
`scripts/gateway-service.mjs` (`configure-cursor`).

---

## 12. Tests & gate (`tests/phase-prompt-guard.test.ts`)

Cumulative suite **220/220 green**, zero-dep, TDD. The 19 prompt-guard tests:

- **Tier 1:** trivia skips Tier 2 / action·risk·code prompts go to Tier 2.
- **analyze:** risky→inject / benign→allow (classifier not called) / classifier
  throws→fail-open / identical prompts hit the cache (one call) / Tier-2 off→allow.
- **helpers:** `buildGuidance` concat + empty / `parseClassifierJson` tolerates
  fences+prose, garbage→null.
- **Claude Code e2e:** guidance in `system[]`, user message unchanged / off-switch
  forwards unchanged / classifier throws→fail-open forwarded / no-clobber of existing
  `system[]` + raw-prompt log separation.
- **Cursor e2e:** risky→inject verdict + `cursor-hook` security-log row / classifier
  throws→`/prompt-guard` fails OPEN, logs nothing / rules generator is
  source-of-truth-faithful + benign logs nothing.
- **Cursor back-fill e2e:** finished turn fills the flagged row's response / unrelated
  or non-cursor source → no-op, no crash / PII in the reply redacted before store +
  superset turn-prompt matches.

Run: `npm test` (full) or
`node --experimental-strip-types --test tests/phase-prompt-guard.test.ts` (this phase).

---

## 13. Live verification (2026-08-06)

- **Claude Code proxy** — guard fired on the live OAuth session, injected guidance;
  output back-filled. Bogus-key probe confirmed live fail-open.
- **Live `/prompt-guard` matrix (Cursor surface, real sonnet-5)** — 25 prompts: **15/15
  recall on risky (correct categories), 0/10 false positives**; educational lookalikes
  (`explain what SQL injection is`, `how JWT works`) correctly `allow`; Tier-1 trivia
  fast-skips 1–3ms, Tier-2 calls 1.6–4.2s.
- **Cursor `.cursor/rules` injection — A/B on the real Cursor Agent:** rules present ⇒
  Agent refused the SQL-concat code and cited project security guidance; rules removed +
  Cursor restarted ⇒ Agent emitted the unsafe f-string. Restored + confirmed == source.
- **Back-fill on the restarted launchd service (this session, PID 1599→9432):** risky
  prompt → `POST /prompt-guard` returned tier-2 `inject` (cats `sql_injection` +
  `missing_auth`) → matching `POST /log-turn` → `GET /security-log` showed ONE row with
  prompt + guidance + redacted `response`.

**Residual gaps:** the `beforeSubmitPrompt` hook *process* (vs curling the endpoint) is
still exercised only hermetically; Tier-2 is Anthropic-only in v1 (other providers get
Tier-1 only).

---

## 14. Invariants (do not regress)

1. **Fail OPEN, always.** No analyzer/classifier path may drop or block a request on an
   error. Blocking happens only on a confident positive detection (and v1 has none).
2. **Never edit the user's message text.** Guidance goes to the SYSTEM channel only.
3. **Raw prompt / guidance body → `securityLog` ONLY** (admin-gated). The PII-safe
   `trafficLog` gets metadata only. The back-filled reply is **redacted before store**.
4. **Zero runtime dependencies.** Node built-ins only; the classifier is `node:https`.
5. **One source of truth for guidance** (`src/guidance.ts`) — both surfaces regenerate
   from it; never fork the wording.
