# AGENTS.md

Tool-agnostic guide for AI coding agents (Claude Code, Cursor, Copilot, Aider, etc.)
working in this repository. It mirrors the essentials; **[CLAUDE.md](CLAUDE.md) is the
canonical operating manual and holds the live Project Status Ledger.** When this file and
CLAUDE.md disagree, CLAUDE.md wins — and update CLAUDE.md's ledger as work progresses.

## The project in one paragraph

`secure-llm-gateway.ts` is the entry point for a **zero-runtime-dependency** local proxy
(modules under `src/`, Node ≥ 22 built-ins only) that sits between LLM clients and
Anthropic/Gemini/OpenAI-compatible upstreams. It redacts PII **bidirectionally** (request
and response, including PII split across streaming SSE chunks), keeps a 100-entry in-memory
traffic log, and embeds an MCP server exposing `get_traffic_logs`. Design authority, in
order: `newplan.md` → `PRD.md` → `IMPLEMENTATION_GUIDE.md`.

## Hard rules (do not violate)

1. **Zero runtime dependencies.** Node built-ins only. No `npm install` of runtime deps, no
   frameworks. If you think you need a package, you don't — flag it instead of adding it.
2. **Module graph under `src/`.** Entry point `secure-llm-gateway.ts` re-exports the public
   barrel. Do not add runtime npm packages.
3. **Never redact auth headers** (`x-api-key`, `Authorization`, `x-goog-api-key`). Redaction
   is body-only.
4. **Never log or persist raw PII.** Snapshots/logs store post-redaction text only.
5. **Fail safe inbound:** if a request can't be redacted, don't forward it unredacted.
6. **Bind `127.0.0.1` only.** No `eval`, no dynamic code.

## The workflow you must follow

**Test-Driven Development, one phase at a time, gated.**

- Write the failing test first → minimum code to pass → refactor green.
- **After each phase, add exactly 3 end-to-end tests: a happy path, a failure path, and an
  edge case.** All three must pass — plus the full cumulative suite — before you start the
  next phase. 2/3 is not done.
- Tests live in `tests/*.test.ts` and run on the **built-in Node test runner** (zero deps):
  `node --experimental-strip-types --test 'tests/*.test.ts'` (aka `npm test`). E2e tests
  drive the real gateway + a local fake upstream; no real provider network calls.
- When a phase's gate goes green: run the full suite, then **update the Project Status
  Ledger in CLAUDE.md §8** in the same change, then commit with the phase tag.

## Phase order

`0` skeleton/contracts → (`A1` redaction → `A2` stream) ‖ (`B1` routing → `B2` proxy+log,
`B3` MCP) → `C` integration + 6 acceptance criteria. Frozen contracts are set in Phase 0;
don't change them unilaterally. See CLAUDE.md §4 for scope, owners, and the concrete
happy/failure/edge test target for each phase.

## Before you finish any change

- Full suite green (`npm test`, currently 81 tests across 13 phase files), no new runtime dependency, no raw PII anywhere, ledger updated.
- After changing redaction rules or gateway code, document `restart --force` in DEVELOPERS.md if lifecycle behavior changed.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
