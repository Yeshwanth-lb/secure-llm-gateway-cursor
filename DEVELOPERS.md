# DEVELOPERS.md — Human Setup, Run & Test Guide

Onboarding for people building the **Secure LLM Gateway Proxy**. For the rules that govern
*how* we work (TDD, the phase gate, coding invariants) see **[CLAUDE.md](CLAUDE.md)** — it is
the operating manual and holds the live status ledger. **[AGENTS.md](AGENTS.md)** is the
short version for AI coding tools.

**Team:** Mohit Sahoo (redaction + streaming), Yeshwanth (routing + proxy + log + MCP).

---

## 1. Prerequisites

- **Node ≥ 22** (this repo is developed on v24). Check: `node --version`.
- That's it. **No dependencies to install** — the gateway and its tests use Node built-ins
  only (`node:http/https/crypto/readline/fs/url/test`). There is intentionally no `node_modules`.

---

## 2. Run the gateway

```bash
# Native TypeScript on Node ≥ 22.6 (type-stripping):
node --experimental-strip-types secure-llm-gateway.ts

# Any Node ≥ 18 via tsx:
npx tsx secure-llm-gateway.ts

# MCP over stdio (for Claude Desktop / Cursor "command" servers):
node --experimental-strip-types secure-llm-gateway.ts --stdio
```

Listens on `http://127.0.0.1:8000` (override with `GATEWAY_HOST` / `GATEWAY_PORT`).

### Point clients at it
```bash
# Anthropic SDK:  ANTHROPIC_BASE_URL=http://localhost:8000
# OpenAI SDK:     OPENAI_BASE_URL=http://localhost:8000/v1
# Gemini:         http://localhost:8000/gemini/…   (or default routing heuristics)
# MCP host config: { "url": "http://localhost:8000/mcp" }
```

### Useful env vars
| Var | Purpose |
|---|---|
| `GATEWAY_HOST` / `GATEWAY_PORT` | Bind address (default `127.0.0.1:8000`). |
| `ANTHROPIC_UPSTREAM` / `GEMINI_UPSTREAM` / `OPENAI_COMPAT_UPSTREAM` | Override upstream bases. |
| `STREAM_HOLDBACK_CHARS` | SSE holdback window (default 96). |
| `CUSTOM_REGEX_RULES` / `CUSTOM_REGEX_RULES_FILE` | Extra redaction rules (JSON), merged ahead of defaults. |

### Admin endpoints (quick human inspection)
`GET /healthz` · `GET /logs` (last 100, post-redaction) · `GET /rules` (active rule names + sources).

---

## 3. Testing — the heart of this project

We build **test-first**, and every phase is **gated by 3 end-to-end tests**. Read CLAUDE.md
§3 for the full contract; the mechanics are here.

### Layout
```
tests/
  helpers/fake-upstream.ts   # local fake provider (:9101), JSON + SSE modes — shared by all e2e tests
  helpers/gateway.ts         # boots the gateway on an ephemeral port, returns {url, close()}
  phase-0.test.ts
  phase-a1.test.ts
  phase-a2.test.ts
  phase-b1.test.ts
  phase-b2.test.ts
  phase-b3.test.ts
  phase-c.test.ts            # the 6 acceptance criteria
```

### Commands
```bash
# Full cumulative suite (must be green before advancing any phase):
node --experimental-strip-types --test 'tests/*.test.ts'

# One phase while developing it:
node --experimental-strip-types --test tests/phase-b1.test.ts
```
Add these to `package.json` scripts once it exists:
```json
{ "scripts": {
    "start": "node --experimental-strip-types secure-llm-gateway.ts",
    "test": "node --experimental-strip-types --test 'tests/*.test.ts'"
} }
```

### The 3-test rule (happy / failure / edge)
After finishing a phase, write **exactly three** e2e tests that drive the real interfaces:

| | What it proves |
|---|---|
| **Happy path** | Valid input → correct result via the real HTTP/MCP/stream surface. |
| **Failure path** | Malformed/hostile input → correct status + error shape, no crash, no leak. |
| **Edge case** | The boundary that's easy to break (PII on a chunk boundary, body exactly at cap, empty stream, terminal-window flush, ambiguous route…). |

CLAUDE.md §4.1 lists the concrete happy/failure/edge target for each phase. All three (and
the whole prior suite) must pass **before** the next phase begins — then update the ledger
and commit.

### E2e test hygiene
- **No real provider calls.** Point the gateway at the fake upstream (`:9101`) via the
  `*_UPSTREAM` env vars inside the test.
- Use **ephemeral ports** and close every server in an `after()`/`afterEach()` hook.
- Assert on **observable behavior**: bytes the upstream received, bytes the client received,
  SSE framing validity, log-entry fields — not internal function calls.
- **No raw PII in fixtures' asserted output** — that's itself one of the invariants under test.

---

## 4. Phase roadmap & ownership

```
Phase 0 (pair) ─┬─ A1 (Mohit) ─► A2 (Mohit) ─┐
                └─ B1 (Yesh) ──► B2 (Yesh) ───┼─► Phase C (pair)
                     B3 (Yesh) ──────────────┘
```

| Phase | Deliverable | Owner |
|---|---|---|
| 0 | Skeleton, config, frozen contracts as stubs, `/healthz`. | pair |
| A1 | Redaction rules + engine (`redactText`/`redactJson`, Luhn CC). | Mohit |
| A2 | `StreamRedactor` (SSE framing, holdback, terminal flush). | Mohit |
| B1 | `resolveRoute` + header forwarding. | Yeshwanth |
| B2 | Proxy pipeline + traffic ring buffer + admin endpoints. | Yeshwanth |
| B3 | MCP server (3 transports) + `get_traffic_logs`. | Yeshwanth |
| C | Integration + 6 acceptance criteria + hardening + runbook smoke. | pair |

**Contracts** (frozen in Phase 0, live near the top of `secure-llm-gateway.ts`): `Provider`,
`RouteResult`, `RedactionRule`, `redactText`, `redactJson`, `LogEntry`, `trafficLog`,
`StreamRedactor`. Both workstreams code against these; stub implementations pass through so
neither developer is blocked while the other fills in the real logic. Don't change a contract
without agreeing with the other owner.

Live progress is tracked in **CLAUDE.md §8 (Project Status Ledger)** — check it before
picking up work so you know which gate is open.

---

## 5. Contributing

1. Branch per phase: `phase/b1-routing` (never commit straight to `main`).
2. TDD: failing test first, minimum code to green, refactor.
3. Finish the phase gate: 3 e2e tests green + full suite green.
4. Update the CLAUDE.md ledger in the same change.
5. Commit with the phase tag and the 3 test names in the body, e.g.
   `feat(b1): routing + header forwarding — gate green (3/3)`.
   End the message with:
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

**Housekeeping note:** `.gitignore` currently holds leftover Python entries from an earlier
abandoned design. When convenient, add Node/TS entries (`node_modules/`, `*.tsbuildinfo`)
and prune the Python ones. The old `ARCHITECTURE.md` (Python/Presidio) is **not** the current
design — see CLAUDE.md §1.
