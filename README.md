# Secure LLM Gateway

A **zero-dependency local proxy** that redacts PII out of LLM traffic **before it leaves your machine**, logs what would have leaked, and exposes an embedded MCP server so agents and reviewers can inspect it.

It sits between an LLM client (Claude Code, Cursor, LangChain, raw SDKs) and the upstream provider families (Anthropic, Gemini, OpenAI-compatible). Built on **Node ≥ 22 built-ins only** — no frameworks, no `npm install` of runtime dependencies. Zero supply-chain surface is a feature.

```
client ──raw──►  LOCAL gateway (127.0.0.1:8000)  ──scrubbed──►  provider
                 · redact request + response
                 · log post-redaction snapshot
                 · MCP get_traffic_logs
```

## What it does

1. **Bidirectional PII redaction** — scrubs the request before any byte leaves (`[REDACTED_PII_<TYPE>]`) and scrubs the model's response, **including PII split across streaming SSE chunk boundaries**.
2. **Traffic logging** — a 100-entry in-memory ring buffer of **post-redaction** snapshots only. Raw PII is never persisted.
3. **Embedded MCP server** — `/mcp` (Streamable HTTP + legacy HTTP+SSE + stdio) with a `get_traffic_logs` tool.

Default rules cover email, SSN, credit cards (Luhn-checked), API keys, JWTs, PEM private keys, DB/URL connection strings, US/India phones, Indian PAN + Aadhaar — with false-positive guards. Custom rules can be added at runtime via the console.

## Quickstart

Requires **Node ≥ 22** (this repo runs `.ts` directly via `--experimental-strip-types`).

```bash
# Run the gateway (foreground)
npm start                 # node --experimental-strip-types secure-llm-gateway.ts
# → listening on http://127.0.0.1:8000

# Health check
curl -s http://127.0.0.1:8000/healthz
```

One-command install as a per-user background service (registers client config too):

```bash
node scripts/gateway-service.mjs install
```

This registers the service, wires client config, and starts fail-closed. There are **no runtime deps to install** — the only `npm install` is dev-only (`typescript`/`@types/node`) for `npm run build`.

## Connecting clients

| Client | How | Coverage |
|---|---|---|
| **Claude Code** | `ANTHROPIC_BASE_URL=http://127.0.0.1:8000` + user-scope `secure-gateway` MCP | **Full** — all model traffic scrubbed both ways (calls the provider locally) |
| **Cursor** | local hooks + `http` MCP | **Partial** — block-if-PII on prompts/file-reads; MCP log inspection |
| **SDKs / LangChain** | point the provider base URL at the gateway | Full — routed by provider (Anthropic / Gemini / OpenAI-compatible) |

> **Why Cursor is only partial:** Cursor makes model calls from **its own cloud servers**, not from your machine, and forbids private-network base URLs — so a loopback gateway is unreachable for Cursor chat. See [`CURSOR_REDACTION_BRIEF.md`](CURSOR_REDACTION_BRIEF.md) for the short version and [`CURSOR_BLOCKER_REPORT.md`](CURSOR_BLOCKER_REPORT.md) for the full investigation.

## Configuration

Environment variables (all optional):

| Var | Default | Notes |
|---|---|---|
| `GATEWAY_HOST` | `127.0.0.1` | Loopback only — throws on any non-loopback host. |
| `GATEWAY_PORT` | `8000` | |
| `GATEWAY_ADMIN_TOKEN` | _(unset)_ | When set, guards `/api` control-plane mutations. |

Auth headers (`x-api-key`, `Authorization`, `x-goog-api-key`) are **never redacted** — redaction is body-only.

## Testing

Built-in Node test runner, zero deps:

```bash
npm test                                              # full suite (89/89)
node --experimental-strip-types --test tests/phase-j.test.ts   # single phase
```

Tests are hermetic — they spin up the real gateway on an ephemeral port plus a local fake upstream, and never touch real provider networks. The project is built **test-first, one phase at a time**, with three end-to-end tests (happy / failure / edge) gating each phase. See [`CLAUDE.md`](CLAUDE.md) §3.

## Layout

```
secure-llm-gateway.ts   entry point + public barrel
src/
  redaction.ts          PII rules + redactText / redactJson
  stream-redactor.ts    SSE framing, rolling holdback, terminal flush
  routing.ts            5-tier provider resolution
  proxy.ts              request pipeline: cap → route → scrub → forward → scrub
  server.ts             HTTP server + control plane + /detect
  mcp.ts                MCP server (3 transports)
  openai-anthropic-shim.ts   OpenAI↔Anthropic translation (Cursor path)
  traffic-log.ts        post-redaction ring buffer
  console.ts / inspector.ts / control-api.ts / model-policy.ts / clean-view.ts
scripts/                gateway-service, client-config, hooks
tests/                  phase-*.test.ts
```

## Documentation

| Doc | What |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Operating manual — workflow, phases, project status ledger (source of truth) |
| [`DEVELOPERS.md`](DEVELOPERS.md) | Human setup / run / test detail |
| [`AGENTS.md`](AGENTS.md) | Tool-agnostic summary |
| [`newplan.md`](newplan.md) · [`PRD.md`](PRD.md) · [`IMPLEMENTATION_GUIDE.md`](IMPLEMENTATION_GUIDE.md) | Design authority (newplan wins on conflict) |
| [`CURSOR_REDACTION_BRIEF.md`](CURSOR_REDACTION_BRIEF.md) | Lead brief — Cursor findings, one screen |
| [`CURSOR_BLOCKER_REPORT.md`](CURSOR_BLOCKER_REPORT.md) | Full Cursor blocker investigation |
| [`CURSOR_TOOL_REDACTION_PLAN.md`](CURSOR_TOOL_REDACTION_PLAN.md) | Phase L plan — `preToolUse`/`postToolUse` tool-data scrub |
| [`CURSOR_INTEGRATION_PLAN.md`](CURSOR_INTEGRATION_PLAN.md) | Cursor integration design + limitations |

## Security invariants

- Binds `127.0.0.1` only. Never a public interface.
- Never logs raw PII — snapshots store post-redaction text only.
- Fails safe inbound: if a request can't be redacted, it is **not** forwarded.
- No `eval`, no dynamic code execution. Custom regexes compile once at startup.
