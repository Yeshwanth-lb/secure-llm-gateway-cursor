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

**Last updated:** 2026-07-21
**Current phase:** Phases 0–C ✅ + frontend (D) + control-plane console (E) ✅ + cross-platform client integration (I) ✅ + Cursor real redaction (J translation shim + K block-hooks) ✅ + Cursor tool-data scrub (L) ✅ + Gemini-web browser extension (G) 🟢 (G1/G2/G3/G-CORS live-verified on gemini.google.com; G4 tripwire hardened + ON by default; **G-Workspace live-verified 2026-07-21 — Gmail/Docs/Sheets/Slides/Chat side panel redacted on the wire**; G5 enterprise pending)
**Overall:** Core gateway, console, model policy, clean view, global client integration, Cursor block-hooks, and Cursor tool-data scrub complete. Gemini-web extension under `extension/` **works end-to-end live** — all 14 default PII types typed into gemini.google.com are redacted to tokens before leaving the browser (verified 2026-07-20 via `scripts/gen-pii-sample.mjs`), logged as one `gemini · CHAT` row with model + clean prompt/output view. G4 tripwire now Luhn-checked + endpoint-scoped and **ON by default** — a DOM-independent fail-closed net that blocks (not leaks) raw PII if a Gemini UI change breaks the DOM path. **Extended to Google Workspace (2026-07-21): the same extension now redacts the Gmail/Docs/Sheets/Slides/Chat "Ask Gemini" side panel — live-verified token-on-the-wire in Docs + Gmail** (additive change, gemini.google.com untouched). Suite 109/109 green + Gemini e2e 8/8. Known limit: `\b`-anchored rules miss PII glued to adjacent chars (see `gemini_imp.md` §7.11).

**Gemini-web extension (Phase G, started 2026-07-20):** New workstream under
`extension/` (sibling to `src/`, not coupled to the gateway module graph — it
only calls `POST /redact` over loopback, same pattern as the Cursor hooks).
Design + phase gates: `scripts/gemini_imp.md` (rev.2). Key decisions:
- **Gemini web can't use the loopback-gateway approach** (like Claude Desktop /
  Cursor chat) — the browser sends prompts from Google's servers, so there's no
  on-machine request path to occupy. The only local interception point is a
  **browser extension** working at the **DOM level** (MV3 forbids rewriting
  request bodies).
- **One-way redaction (rev.2).** No reversible map, no restore-for-display. The
  user's own message and every reply permanently show fixed tokens
  (`[REDACTED_PII_EMAIL]`). This deliberately deleted an entire complexity class
  and means the **existing `/redact` endpoint is reused UNCHANGED** (no new
  backend, no map field).
- **The real risk is Stage 3 (kill + re-fire), not the DOM read.** You can't
  pause a DOM event across an async gateway call, so the design fully kills the
  original submit (`preventDefault` + `stopImmediatePropagation` on a
  `document`-level capture listener) and independently re-fires a redacted
  submit. Two failure modes are handled explicitly: (a) **loop guard** — our own
  synthetic re-submit must not be re-intercepted (flag + event tag +
  `isTrusted:false` check, in `extension/src/interceptor-core.js`); (b)
  **framework model sync** — writing text must use the native setter + a real
  `input` event or the framework may submit stale pre-redaction text.
- **Testable core factored out.** Loop guard / fail-closed / tripwire-predicate
  are pure and unit-tested headlessly (`tests/phase-gemini-core.test.ts`); the
  selector/DOM code (`composer.js`) can only be validated against the live
  Gemini page (Stages 2/3/5, manual — see `extension/README.md`).
- **MV3 loading:** content scripts can't `import`, so an isolated-world
  `loader.js` injects the MAIN-world ES module via `web_accessible_resources`
  (no bundler, stays zero-build).
- **CORS blocker found + fixed (2026-07-20).** The gateway grants CORS to
  **loopback origins only** (`src/server.ts` `corsHeaders`, §5) and the `/redact`
  **POST** response carries no `Access-Control-Allow-Origin` at all (only the
  OPTIONS preflight does). So a fetch from the page (MAIN world, gemini.google.com
  origin — or even a loopback page origin) is browser-blocked → the extension
  would fail closed on every message. Fix: the gateway is left UNCHANGED; the
  `/redact` fetch moved to a **background service worker** (`src/background.js`),
  which has `host_permissions` for `127.0.0.1:8000` and is not subject to page
  CORS. Path is now MAIN → `CustomEvent` → isolated bridge →
  `chrome.runtime.sendMessage` → SW → fetch. The page never fetches the gateway.
- **e2e harness (Playwright, dev-only dep).** `npm run test:gemini-e2e` drives
  the REAL `content-main.js` in headless Chromium against a fake Gemini page
  backed by the real gateway, proving the Stage-3 mechanics: capture-phase
  intercept kills the original submit, redacted text is written+read
  (model-sync), a synthetic re-submit fires and is NOT re-intercepted (loop
  guard = exactly one gateway call + one send), zero raw PII leaves, and
  gateway-down blocks the send. 8/8. Does NOT cover the real gemini.google.com
  selectors or the SW/CORS plumbing end-to-end — those stay manual (Chrome).

**Cursor architecture finding (2026-07-14):** Cursor CHAT cannot be routed through a
loopback gateway — Cursor makes provider calls from its OWN cloud servers and bans
private-network base URLs ("Access to private networks is forbidden"). Confirmed live
(gpt-4o probe). So base-URL redaction (Phase J) is unshippable for Cursor chat; the shim
stays valid for Claude Code / direct callers. Cursor coverage is therefore: block-if-PII
(K) on prompts/file-reads + tool-data SCRUB (L) on preToolUse/postToolUse. Full writeup:
`CURSOR_BLOCKER_REPORT.md`, `CURSOR_REDACTION_BRIEF.md`. Hook-capability correction: Cursor
hooks are NOT all block-only — `preToolUse` (updated_input) and `postToolUse`
(updated_mcp_tool_output) CAN rewrite; the prompt/file hooks we use are block-only.

**`/models` root-path fix (2026-07-13):** `/models` handler now matches both `/openai`-
prefixed and bare-root paths (`^/(?:openai/)?(?:v1/)?models$`) — a bare-root Cursor base URL
404'd validation while chat worked at root. Regression in `tests/phase-j.test.ts`.

**`configure-cursor` merge bug FIXED (2026-07-14):** now writes our MCP entry as a fresh
HTTP-only object (replace, not deep-merge), so a prior stdio-shaped entry leaves no stale
`command`/`args`/`envFile` keys; other servers preserved. Regression in `tests/phase-i.test.ts`.

**Operational bootstrap (verified 2026-07-10):** The single bootstrap command is
`node scripts/gateway-service.mjs install` — it registers the per-user service, runs
`configure-clients` (global `~/.claude/settings.json`: `ANTHROPIC_BASE_URL` + SessionStart
hook + user-scope `secure-gateway` MCP; `~/.cursor/mcp.json` + `hooks.json`), and starts
fail-closed. **No runtime deps to install** (zero-dep is a hard constraint; the only
`npm install` is dev-only `typescript`/`@types/node` for `npm run build`). Verified live:
gateway healthy on `127.0.0.1:8000`, `doctor` 11/11 `[OK]`, Claude+Cursor hooks present,
outbound `EMAIL` redaction confirmed end-to-end from a real Claude Code prompt. See
DEVELOPERS.md §0 Quickstart.

**~~Known bug~~ FIXED — `configure-cursor` merge (fixed 2026-07-14):** `configure-cursor`
used to deep-merge into an existing `secure-gateway` entry, leaving stale stdio
`command`/`args`/`envFile` keys beside the new `type: http` + `url` when migrating from the
removed `mcp-remote-bridge.mjs`. Now writes our entry as a fresh HTTP-only object (replace,
not merge); other servers preserved. Regression test in `tests/phase-i.test.ts`.

**Loopback-only (2026-07-10):** All remote/cloud (Render) support was removed. The
gateway binds `127.0.0.1` only — `loadConfig` throws on any non-loopback `GATEWAY_HOST`
(no `GATEWAY_REMOTE`, no `0.0.0.0`, no `RENDER` detection). Deleted `render.yaml` and
`scripts/mcp-remote-bridge.mjs`; dropped `--remote-url`/`init-env` and the
`GATEWAY_PUBLIC_URL`/`GATEWAY_MCP_TOKEN` plumbing. Clients connect over loopback:
Claude via `ANTHROPIC_BASE_URL=http://127.0.0.1:8000` + `http` MCP, Cursor via `http`
MCP. Control plane is loopback-Origin gated (`GATEWAY_ADMIN_TOKEN` still allows a
cross-origin caller).

**Redaction expansion (2026-07-10):** Default rules grew beyond the original 7 to cover
high-signal Claude-session leaks — JWT, PEM private keys, DB/URL userinfo, expanded
API key families, US/+91 phones, Indian PAN + Verhoeff Aadhaar — with FP guards
(no bare 10-digit, no invalid Aadhaar, wall-clock untouched).

**Global client config fix (2026-07-10):** `scripts/gateway-service.mjs configure-clients`
now writes user-level Claude Code and Cursor configuration (`~/.claude/settings.json`,
`~/.cursor/mcp.json`, `~/.cursor/hooks.json`) so new repos inherit the gateway setup.
Cursor hooks use `scripts/cursor-gateway-hook.mjs` with fail-closed
`sessionStart`/`beforeMCPExecution` only; repo-local `.cursor/mcp.json` and
`.cursor/hooks.json` are no longer needed. Loopback `127.0.0.1` is preserved in
redacted hook messages, while public IPv4 addresses still redact.

**Ops + connection hardening (2026-07-10):** Unified Claude SessionStart on
`claude-session-hook.mjs` (start + fail-closed health). `gateway-service` adds
`restart`/`--force`, installId-aware health, stop-by-port. StreamRedactor scrubs
`thinking_delta`. `/api` POST mutations require `GATEWAY_ADMIN_TOKEN` when set.

**JWT rule fix (2026-07-10):** Payload no longer required to start with `eyJ`
(catches short payloads like `e30`); signature allows optional `=` padding. Added
multi-JWT and split-stream tests.

**Cursor real redaction — Phases J + K (2026-07-13):** Cursor now gets full
bidirectional redaction of chat/agent traffic (not just MCP inspection). Design
decisions worth remembering:
- **Single endpoint, model-name routing (NOT two endpoints).** Cursor exposes ONE
  global "Override OpenAI Base URL", so a second gateway path can never be reached
  alongside the first from one Cursor install. Point Cursor's OpenAI base URL at
  `http://127.0.0.1:8000/openai`; the proxy branches on the request's `model` id:
  a `claude-*` id or a configured alias (`CURSOR_TRANSLATE_MODELS`, default
  `claude-via-gateway`) → translate to the Anthropic Messages API and forward to
  Claude; any other model → pass through to OpenAI unchanged. See
  `shouldTranslate()` in `src/openai-anthropic-shim.ts` and the decision block in
  `src/proxy.ts`.
- **Translation shim** (`src/openai-anthropic-shim.ts`): `openaiToAnthropicRequest`,
  `anthropicToOpenAIResponse`, and `AnthropicToOpenAISSE` (streaming reframer that
  runs AFTER the existing StreamRedactor, so split-PII holdback is reused). Redaction
  engine untouched — it scrubs whatever body is present. Auth swap: client's OpenAI
  bearer dropped, server-side `ANTHROPIC_API_KEY` + `anthropic-version` added (real
  key never touches the client). Model map `CURSOR_MODEL_MAP` resolves alias → real
  Claude id; `CURSOR_DEFAULT_MODEL` / `CURSOR_MAX_TOKENS` fill gaps.
- **Model-policy ordering fix:** the block check now runs on the RESOLVED Claude
  model, so a blocked Claude model can't slip through under an OpenAI alias.
- **Hooks are block-only (Phase K).** Cursor's `beforeReadFile`/`beforeTabFileRead`/
  `beforeSubmitPrompt` can only allow/deny — they CANNOT rewrite content (verified
  against cursor.com/docs/hooks). `scripts/cursor-redact-hook.mjs` DETECTS PII via
  `POST /detect` (loopback-gated, uses the live rule set, never logs raw text) and
  DENIES when found; fail-closed on any error. Tab autocomplete file *reads* can be
  blocked but not scrubbed; Apply-from-Chat is uncoverable (Cursor's own backend).
- **Test note:** Phase K tests must spawn the hook with async `spawn`, not
  `spawnSync` — `spawnSync` blocks the parent event loop and deadlocks the
  in-process gateway serving `/detect`.
- Full rationale + limitations: `CURSOR_INTEGRATION_PLAN.md`.

**Cursor model-validation fix (2026-07-13):** Cursor validates a custom model by
`GET`ting `/v1/models` on its "Override OpenAI Base URL". That GET has no body, so
the shim can't route it, and it was proxied to real OpenAI → 401 on the dummy key →
Cursor reported *"Model name is not valid: claude-via-gateway"* and blocked the chat
before any translate request was sent. `src/server.ts` now answers
`GET /openai/(v1/)?models` locally with a synthetic OpenAI model list built from
`config.cursorTranslateModels` (loopback bind, no secrets). Regression test added to
`tests/phase-j.test.ts`. Suite 88/88.

**Cursor model-echo fix (2026-07-13, the actual "not valid" root cause):** After the
`/models` fix, Cursor *still* reported *"Model name is not valid: claude-via-gateway"*
on send. Real cause: the translate response echoed the RESOLVED Claude id
(`claude-sonnet-5`) in the OpenAI `model` field, but OpenAI-compatible clients validate
a custom model by matching the returned `model` against what they SENT. `src/proxy.ts`
now echoes the client's requested id (`clientModel`, the alias) in both the non-stream
`anthropicToOpenAIResponse` and the `AnthropicToOpenAISSE` reframer; the resolved id is
still used for policy checks, forwarding, and log entries. Verified live: request
`model:"claude-via-gateway"` → response `model:"claude-via-gateway"`, forwarded body
`model:"claude-sonnet-5"`.
- **Reverted a bad prior workaround:** `DEFAULT_CURSOR_TRANSLATE_MODELS` had been
  changed to `["claude-via-gateway", "gpt-4o"]` on the wrong theory that Cursor rejects
  invented names before calling the base URL. That hijacked genuine `gpt-4o` to Claude
  and broke the Phase-J pass-through test. Restored to `["claude-via-gateway"]`. The
  echo fix — not a gpt-4o alias — is the correct solution. Suite 88/88.

**Cursor `/models` root-path fix (2026-07-13, "not valid" recurrence):** The
`/models` handler only matched `^/openai/(v1/)?models$`. When Cursor's "Override
OpenAI Base URL" is set to the bare gateway root (`http://127.0.0.1:8000`, no
`/openai` segment), model validation GETs `/v1/models` at root → 404, while chat
POSTs at root (`/v1/chat/completions`) route to the shim and work — asymmetric, so
Cursor reports *"Model name is not valid: claude-via-gateway"* on send even though
the translate path is healthy. `src/server.ts` regex broadened to
`^/(?:openai/)?(?:v1/)?models$` so both root and `/openai`-prefixed probes answer
locally. Regression test in `tests/phase-j.test.ts`. Suite 89/89.


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
| K — Cursor block-if-PII hook | ✅ Done | file-read PII denied / clean allowed + malformed-stdin fail-closed / prompt secret blocked, clean allowed | ✅ 3/3 | `scripts/cursor-redact-hook.mjs` + `POST /detect` (loopback-gated, never logged). Block-only (these prompt/file hooks can't rewrite). `tests/phase-k.test.ts`. |
| L — Cursor tool-data scrub | ✅ Done | postToolUse rewrites MCP output (PII→tokens) / gateway-down → preToolUse deny + postToolUse withhold (no raw) / nested input scrubbed, clean input untouched | ✅ 3/3 | `scripts/cursor-tool-redact-hook.mjs` + `POST /redact` (loopback-gated, never logged). Rewrite hooks: `preToolUse.updated_input`, `postToolUse.updated_mcp_tool_output`. **Live-verified 2026-07-14** against Cursor 3.9.16 — field names confirmed `tool_input` (object) / `tool_output` (string); real-payload scrub of EMAIL+CC end-to-end. `tests/phase-l.test.ts`. |

**Gemini-web extension (Phase G) — sub-ledger.** Separate deliverable under `extension/`; design + gates in `scripts/gemini_imp.md`. DOM stages are **browser-gated** (validated against the live Gemini page, not `npm test`) — see `extension/README.md`.

| Stage | Status | E2e / unit tests (happy / failure / edge) | Suite green? | Notes |
|---|---|---|---|---|
| G1 — Gateway `/redact` contract | ✅ Done | single email→fixed token / malformed→200 empty (shipped behavior) / multi-PII replaced + clean untouched | ✅ 3/3 | Verification only — endpoint reused UNCHANGED (no map). `tests/phase-gemini.test.ts`. |
| G-core — Interceptor control logic | ✅ Done | loop guard (synthetic/in-flight/untrusted not intercepted) / fail-closed decision / tripwire predicate | ✅ 7/7 | Pure, headless. `extension/src/interceptor-core.js` + `tripwire.js`; `tests/phase-gemini-core.test.ts`. |
| G2 — Extension skeleton (loads/locates) | 🟡 Scaffolded | manual: activates on gemini.google.com, locates composer / inert on other domains / waits for late-rendered composer | n/a (browser) | `manifest.json`, `loader.js`, `content-bridge.js`, `composer.js`. Selectors need live tuning. |
| G2 — Extension skeleton (loads/locates) | ✅ Live-verified 2026-07-20 | loads on gemini.google.com, `composer match: div.ql-editor[contenteditable="true"]` confirmed live / inert off-domain / SPA late-render handled | n/a (browser) | First composer selector matches the real Gemini DOM. |
| G3 — Intercept + redact + re-submit | ✅ Live-verified 2026-07-20 | e2e 8/8 (headless) + **real gemini.google.com: real email typed → sent bubble shows `[REDACTED_PII_EMAIL]`, raw never sent** / gateway-down blocks send / send-button path | ✅ e2e 8/8 + live | `extension/test/e2e/run.mts`. Live proof resolved the two hardest risks: (a) synthetic re-submit DOES trigger Gemini's Angular send; (b) **Quill model-sync** — a bare `textContent` write leaked raw because Gemini reads Quill's Delta, which syncs from the DOM ASYNC; fixed with `execCommand("insertText")` in `composer.writeText` + a 120ms yield before re-fire so the Delta absorbs the change. |
| G-CORS — Background SW fetch path | ✅ Fixed + live-verified 2026-07-20 | page-world `/redact` is CORS-blocked → moved to background SW; gateway 403'd the SW's `chrome-extension://` origin → gateway now allows extension origins on `/detect`+`/redact` only | ✅ 104/104 | `src/background.js` + bridge relay; `src/server.ts` `isExtensionOrigin`. Foreign http(s) origins still blocked; hook endpoints expose no stored data. Port: gateway runs **8001** (not 8000) — extension defaults + `host_permissions` updated. |
| G6 — Per-turn logging (provider+model+clean view) | ✅ Live-verified 2026-07-20 | `/log-turn` unit-tested (gemini entry, redacted prompt+response, clean view, no raw PII) + **live: Inspector shows `gemini / gemini-flash · CHAT`, clean view = redacted user prompt + full assistant output** | ✅ 106/106 + live | New `POST /log-turn` logs ONE `CHAT` row per turn: `provider:gemini` + model + `clean{userPrompt,assistantOutput}`, rendered like a Claude turn. Send-time `/redact` passes `audit:false` (no duplicate row). Extension captures the reply via a settle-debounced MutationObserver (`readLatestResponse`) + `getModel()` — both selectors hit live on first try. Sends the RAW prompt to `/log-turn` (gateway redacts before store) so PII flag/counts are accurate; only redacted text persisted. |
| G4 — Fail-closed tripwire | ✅ Done (ON by default) | happy: redacted body on Gemini endpoint not aborted / failure: raw PII on Gemini endpoint aborted (fetch+XHR) + blocked event / edge: non-Luhn digits + off-endpoint telemetry NOT aborted | ✅ 109/109 | `tripwire.js` rewritten: `luhnValid` (mirrors `src/redaction.ts`), `bodyLooksRaw` (Luhn-gated card), `shouldInspectUrl` + `DEFAULT_GEMINI_ENDPOINTS` (endpoint scoping — telemetry false-positive fixed), `extractUrl`, XHR `open`-wrap. ON by default (`config.tripwire:false` / `tripwireEndpoints` to override via storage). Endpoint list is live-tunable like the selectors — **confirm against the real Network tab**. `tests/phase-gemini-core.test.ts`. |
| G5 — Health check + enterprise deploy | ⬜ Not started | broken selector → fail closed / force-install can't be removed / managed config applied | — | `selectorsHealthy()` + 15s poll stubbed in; Admin-console rollout not done. |
| G-Workspace — Google Workspace side panel (Gmail/Docs/Sheets/Slides/Chat) | ✅ Live-verified 2026-07-21 | live: Docs + Gmail + **Sheets** + Chat network-proven (raw→zero matches; token in streamGenerate/create_message) / Enter-key path works (not just the ↑ arrow) / tripwire `shouldInspectUrl` covers `streamGenerate` | ✅ 109/109 + live | **Additive, gemini.google.com untouched.** `manifest.json` +Workspace hosts (mail/docs/drive/chat) in both match arrays; `composer.js` +`div[contenteditable][aria-label*="Ask Gemini" i]` selector (appsElements, NOT Quill — top-level DOM, not shadow/iframe); `content-main.js` `fireSubmit` now picks the **enabled+visible** send button (Workspace renders a **disabled decoy** `aria="Submit"` beside the real one) and dispatches a **full pointer sequence** (Gm3 Material buttons ignore a bare synthetic click); `tripwire.js` `DEFAULT_GEMINI_ENDPOINTS` +`streamGenerate`/`appsgenaiservice` (Workspace endpoint is lowercase, on appsgenaiservice host). **Selector-order fix (Sheets):** the `aria*="Ask Gemini"` selector must precede the generic `role=textbox`/`textarea` catch-alls in `composer.js` — Sheets' empty stray `role=textbox` boxes were hijacking `findComposer` → `readText`="" → send went out unredacted; reorder fixed it (Quill still first, gemini web unaffected). `content-main.js` has `CONFIG.debug` tracing in `onSubmitEvent` (off) that pinpointed it. Shared panel → one fix covers all five apps. **Drive: in manifest but still untested.** |


**Status legend:** ⬜ Not started · 🟡 In progress · 🔴 Tests red (gate closed) · ✅ Done (gate green)

**How to update this ledger:** when a phase's gate goes green, set its row to ✅, fill in the
three test names, mark suite green, bump *Last updated* and *Current phase*, and adjust the
*Overall* count. When you start a phase, set it 🟡. When tests are failing, set 🔴 so the
closed gate is visible. Never advance *Current phase* past a row that isn't ✅.