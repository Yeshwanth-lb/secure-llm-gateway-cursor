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

| Constraint | Rule |
|---|---|
| Runtime | **Node ≥ 22** built-ins **only** (`node:http`, `node:https`, `node:crypto`, `node:readline`, `node:fs`, `node:url`, `node:test`). This machine runs Node v24. |
| Dependencies | **Zero.** No `npm install` of runtime deps, no frameworks. Zero supply-chain surface is a feature, not an accident. |
| Deliverable shape | **Module graph under `src/`** with `secure-llm-gateway.ts` as entry point + public barrel. *(Decision 2026-07-09, Mohit: the original single-file mandate in `newplan.md`/`IMPLEMENTATION_GUIDE.md` was intentionally overridden for maintainability. Still zero-dep, still `.ts` run directly.)* |
| Run | `node --experimental-strip-types secure-llm-gateway.ts` (or `npx tsx …` on older Node). |
| Bind | `127.0.0.1:8000` only (`GATEWAY_HOST`/`GATEWAY_PORT`). Never `0.0.0.0`. |
| Auth headers | **Never redact** auth headers (`x-api-key`, `Authorization`, `x-goog-api-key`). Redaction is **body-only**. |
| No `eval` | No dynamic code execution, ever. Custom regexes compile once at startup. |

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

| Phase | Scope (one line) | Owner | Design ref |
|---|---|---|---|
| **0** | Skeleton, config loader, contracts as throwing stubs, `GET /healthz`. | pair | IG Phase 0 |
| **A1** | 7 default redaction rules (Luhn CC), custom-rule loader, `redactText`/`redactJson`. | Mohit | newplan §3.1–3.3 |
| **A2** | `StreamRedactor` — SSE framing, rolling holdback, terminal flush injection. | Mohit | newplan §3.4 |
| **B1** | `resolveRoute` (5-tier), header forwarding (hop-by-hop strip, `accept-encoding: identity`). | Yeshwanth | newplan §2 |
| **B2** | Proxy pipeline (body cap→route→scrub→forward→scrub response), traffic ring buffer, admin endpoints. | Yeshwanth | newplan §4, §6 |
| **B3** | MCP server: JSON-RPC 2.0 over Streamable HTTP + legacy HTTP+SSE + stdio; `get_traffic_logs`. | Yeshwanth | newplan §5 |
| **C** | Integration + the 6 acceptance tests, hardening pass, runbook smoke. | pair | newplan §8 |

**Frozen contracts** (locked in Phase 0, changed only by mutual agreement — see
`IMPLEMENTATION_GUIDE.md` "Contracts"): `Provider`, `RouteResult`, `RedactionRule`,
`redactText`, `redactJson`, `LogEntry`, `trafficLog`, `StreamRedactor`. Both workstreams
code against these seams; stubs pass through until filled so no one is blocked.

### 4.1 Concrete phase-gate test targets
The three tests per phase should aim at these (adapt names, keep the happy/failure/edge trio):

- **Phase 0** — happy: `/healthz` → 200; failure: unknown path → 404 JSON hint; edge: body over cap → 413.
- **A1** — happy: object with email/SSN/CC/api-key → correct tokens + counts; failure: malformed input degrades to raw-text scrub (no throw); edge: non-Luhn 16-digit number left untouched.
- **A2** — happy: clean SSE stream passes through with valid framing; failure: bad/partial JSON in a `data:` event doesn't crash the redactor; edge: email split across 3 chunks → `[REDACTED_MOCK_PII]`, PII in final window flushed before terminal event, nothing dropped.
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

**Last updated:** 2026-07-10
**Current phase:** Phases 0–C ✅ + frontend (D) + control-plane console (E) ✅
**Overall:** Core 7/7 + inspector + console + MCP/proxy e2e + clean-view + model-policy. Suite 61/61 green.
**Model policy (2026-07-10):** "Model Policy" console tab — toggle models to BLOCK. A blocked model is rejected `403` at the proxy BEFORE forwarding (never leaves the machine) and logged (`blocked:true`, status 403). Live via `/api/models/toggle`; state in `/api/state`. Seeded list (Cursor Grok 4.5, Composer 2.5, Opus 4.8, GPT-5.6 Sol/Terra/Luna, GPT-5.5, Sonnet 5, Sonnet 4.6, Opus 4.7, Gemini 3.1 Pro, Haiku 4.5, Gemini 3.5 Flash, Kimi K2.7 Code) plus each Claude model listed BY NAME (Claude Opus 4.8/4.7, Sonnet 5/4.6, Haiku 4.5, Fable 5) — no lumped catch-all. Model id detected from body `model` / gemini path; added to `LogEntry.model`. `src/model-policy.ts`, `tests/phase-h.test.ts`.
**Snapshot + clean-view (2026-07-10):** snapshot cap now configurable (`SNAPSHOT_CHARS`, default 256KB, 0=unlimited) so the full redacted turn incl. the trailing `system` prompt is captured (was clipped at 500). Added "strip Claude boilerplate" toggle in the Traffic tab → `GET /logs?clean=1` attaches a distilled `{ userPrompt, assistantOutput }` per entry (drops `<system-reminder>`/CLAUDE.md/`system`/tool cruft, reassembles assistant text from SSE deltas). Pure extractors in `src/clean-view.ts`; `tests/phase-g.test.ts`.
**Always-on routing (2026-07-10):** `.claude/settings.json` sets `env.ANTHROPIC_BASE_URL=http://localhost:8000` (project scope) + a `SessionStart` hook (`scripts/ensure-gateway.sh`) that auto-starts the gateway if down — fully automated, self-healing.
**Console button fix (2026-07-10):** one mismatched quote in the allowlist row template broke the whole inline script → every button dead. Fixed; added a regression test that compiles the served `<script>` with `new Function` (`tests/phase-e.test.ts`). Added `tests/phase-f.test.ts` — 3 proxy + 3 MCP e2e through the real gateway; MCP `get_traffic_logs` verified to read the proxy's LIVE redacted log.
**Console (2026-07-10):** control-plane webpage served at `GET /` `/console` `/inspector` AND `GET /mcp` for browsers (content-negotiated: `Accept: text/html`→console, `Accept: text/event-stream`→MCP legacy SSE, `POST /mcp`→JSON-RPC — same URL, no collision). Tabs: **Rules** (live enable/disable toggles, source badges, add/remove runtime custom regex), **Allowlist** (exception patterns never redacted; add/toggle/remove), **Traffic Inspector** (polls `/logs`, expandable post-redaction snapshots + matched-rule counts). Backed by live `/api/*` acting on a mutable redaction registry shared in-process with the proxy — toggles/adds take effect immediately, no restart. Never stores/renders raw PII. `src/{console,control-api}.ts`, redaction registry in `src/redaction.ts`, `tests/phase-e.test.ts`.
**Live-test fix (2026-07-09):** real Claude Code traffic exposed a StreamRedactor bug — the synthetic holdback-flush delta dropped its SSE `event:` line, so Anthropic clients ignored it and recorded an empty assistant text block → next turn failed `400 text content blocks must be non-empty`. Fixed by preserving `lastDeltaFields` and re-emitting them on flush. Regression test in `tests/phase-a2.test.ts`. Also: stdio bootstrap now survives a busy HTTP port instead of crashing (unhandled `error` event).
**Layout:** modularized 2026-07-09 — `src/{contracts,config,redaction,stream-redactor,routing,traffic-log,proxy,mcp,http-utils,server}.ts`; `secure-llm-gateway.ts` = entry + barrel. Tests import via the barrel; shared e2e helpers in `tests/helpers/{fake-upstream,net}.ts`.

| Phase | Status | E2e tests (happy / failure / edge) | Suite green? | Notes |
|---|---|---|---|---|
| 0 — Skeleton & contracts | ✅ Done | `/healthz`→200 / unknown→404 hint / body>cap→413 | ✅ 3/3 | Contracts frozen; stubs throw "not implemented". `tests/phase-0.test.ts`. Node 22 strip-only mode → no param-properties. |
| A1 — Redaction engine | ✅ Done | email/SSN/CC/api-key tokens+counts / malformed→raw scrub no-throw / non-Luhn 16-digit untouched | ✅ 4/4 | 7 default rules + Luhn; custom-rule loader (env+file, merged ahead); §3.2 overlap resolution; zero-length guard; deep-walk `redactJson`. `tests/phase-a1.test.ts`. |
| A2 — StreamRedactor | ✅ Done | clean SSE round-trip / bad JSON no-crash / email split 3 chunks→`[REDACTED_MOCK_PII]` flushed before `[DONE]` / regression: anthropic flush keeps `event:` line | ✅ 4/4 | SSE framing, rolling holdback (default 96), flush injection (preserves SSE `event:` fields), per-provider text-channel extraction. `tests/phase-a2.test.ts`. |
| B1 — Routing | ✅ Done | `/openai/*` prefix→openai+strip / unroutable→null / ambiguous `/v1/models`+`x-api-key`→anthropic sniff | ✅ 5/5 | 5-tier `resolveRoute` (returns `RouteResult\|null` — contract extended from throw, agreed 2026-07-09); `buildForwardHeaders` (hop-by-hop strip, `accept-encoding: identity`, auth preserved, control headers dropped); `x-llm-upstream` override. `tests/phase-b1.test.ts`. |
| B2 — Proxy + log | ✅ Done | bidi redaction + entry logged / upstream down→502 logged / PII-heavy snapshot has no raw PII | ✅ 3/3 | Full pipeline: inbound scrub→forward (recompute length)→outbound scrub (JSON buffer / SSE via StreamRedactor)→finalize LogEntry. 100-entry ring buffer (newest-first, `clear()` test seam). Admin `GET /logs`, `GET /rules`. `src/proxy.ts`, `tests/phase-b2.test.ts`. |
| B3 — MCP server | ✅ Done | initialize→tools/list→tools/call over Streamable HTTP (live log) / unknown method→-32601 / stdio stdout protocol-pure | ✅ 3/3 | One JSON-RPC dispatcher; transports: Streamable HTTP (`POST/GET/DELETE /mcp`), legacy HTTP+SSE (`/mcp/messages`), stdio (`--stdio`); tool `get_traffic_logs`. `src/mcp.ts`, `tests/phase-b3.test.ts`. |
| C — Integration | ✅ Done | 6 acceptance criteria (PRD §7) as happy set / malformed-JSON→raw-scrub no-crash / zero-length-regex guard + 127.0.0.1 bind | ✅ 11/11 | Full-stack e2e: inbound scrub, SSE fracture+flush, MCP over all 3 transports (Streamable HTTP / legacy SSE / stdio), 3-tier routing, Luhn false-positive kill. Hardening trio + runbook smoke (admin + MCP endpoints) verified. `tests/phase-c.test.ts`. |
| D — Traffic inspector (frontend) | ✅ Done | `GET /`→200 html / `/inspector` alias / `POST /` not html / page polls `/logs` | ✅ 4/4 | Zero-dep self-contained HTML dashboard (superseded by the console but kept as `/inspector` alias). `src/inspector.ts`, `tests/phase-d.test.ts`. |
| E — Control-plane console + `/api` | ✅ Done | `GET /mcp`(html)→console & (event-stream)→SSE + EMAIL toggle changes live redaction / custom rule redacts live / allowlist exempts value / bad regex→400 / default-rule remove→400 / unknown toggle→404 | ✅ 8/8 | Console at `/`,`/console`,`/inspector`,`GET /mcp`(browser). Live `/api/*` on a mutable rule registry (enable/disable, runtime custom rules, allowlist) shared with the proxy. `src/{console,control-api}.ts`, `tests/phase-e.test.ts`. |

**Status legend:** ⬜ Not started · 🟡 In progress · 🔴 Tests red (gate closed) · ✅ Done (gate green)

**How to update this ledger:** when a phase's gate goes green, set its row to ✅, fill in the
three test names, mark suite green, bump *Last updated* and *Current phase*, and adjust the
*Overall* count. When you start a phase, set it 🟡. When tests are failing, set 🔴 so the
closed gate is visible. Never advance *Current phase* past a row that isn't ✅.
