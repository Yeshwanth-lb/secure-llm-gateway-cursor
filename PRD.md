# PRD — Secure LLM Gateway Proxy

**Owners:** Mohit Sahoo, Yeshwanth
**Status:** Draft v1
**Source of truth:** `newplan.md` (technical design). This PRD frames the *why/what*; the implementation guide frames the *how/who*.

---

## 1. Problem

Developers and agents (Cursor, Claude Code, LangChain, AutoGen) send requests straight to LLM providers (Anthropic, Gemini, OpenAI-compatible). Two risks:

1. **Inbound leak** — real PII/secrets (emails, SSNs, credit cards, API keys) leave the machine inside prompts.
2. **Outbound leak** — the model fabricates or echoes PII back to the user/logs.

No local, transparent control point exists to scrub both directions without changing client code.

## 2. Goal

A **zero-runtime-dependency** local proxy (`secure-llm-gateway.ts` + `src/` modules) that sits between any LLM client and any of three provider families, redacting PII **bidirectionally** — including PII split across streaming SSE chunk boundaries — while exposing live traffic observability via an embedded MCP server.

## 3. Non-Goals

- Not a cloud service. Binds `127.0.0.1` only.
- Not a full DLP suite — regex + Luhn, not ML classification.
- No persistence beyond a 100-entry in-memory ring buffer.
- No auth-header redaction (auth must pass through intact).

## 4. Users

| User | Need |
|---|---|
| Individual dev | Point SDK base URL at proxy, get scrubbing for free. |
| Agent framework | Same, plus MCP tool to inspect what leaked. |
| Security reviewer | `GET /logs`, `/rules`, `/healthz`, and `get_traffic_logs` MCP tool to audit traffic post-redaction. |

## 5. Functional Requirements

- **FR1 Routing** — resolve provider by path prefix → header → path heuristic → header sniff → 404 hint. (`newplan.md` §2)
- **FR2 Header forwarding** — copy all client headers verbatim except hop-by-hop; force `accept-encoding: identity`; recompute `content-length`; never redact auth headers.
- **FR3 Inbound redaction** — deep-walk request JSON (or raw text), scrub to `[REDACTED_PII_<TYPE>]` before any byte leaves.
- **FR4 Outbound redaction** — scrub response text to `[REDACTED_MOCK_PII]`.
- **FR5 Streaming redaction** — rolling holdback redactor catches PII spanning SSE chunk boundaries; valid SSE framing preserved; terminal flush injection; nothing dropped. (`newplan.md` §3.4)
- **FR6 Redaction rules** — 7 default rules (API_KEY, BEARER_TOKEN, EMAIL, CREDIT_CARD w/ Luhn, SSN, IPV4, IPV6); custom rules via env/file merge ahead of defaults.
- **FR7 Traffic log** — 100-entry ring buffer, post-redaction snapshots only, per-request metadata + matched-rule counts. (`newplan.md` §4)
- **FR8 Admin endpoints** — `GET /logs`, `/rules`, `/healthz`.
- **FR9 MCP server** — JSON-RPC 2.0 over 3 transports (Streamable HTTP, legacy HTTP+SSE, stdio); tool `get_traffic_logs`. (`newplan.md` §5)
- **FR10 Hardening** — 25 MB body cap (413), upstream errors → 502 JSON, malformed JSON degrades to raw-text scrub, no eval, zero-length-match guard, stdout protocol-pure in stdio mode.

## 6. Non-Functional Requirements

- Node ≥ 22 built-ins only; runs via `node --experimental-strip-types` or `npx tsx`.
- Streaming path never whole-buffers the response — real-time passthrough.
- Single process; all shared state in-memory so MCP reads live data.

## 7. Success Criteria (acceptance)

Maps to `newplan.md` §8 verification:

1. Inbound email/SSN/CC/API-key → upstream receives `[REDACTED_PII_*]`.
2. Email split mid-string across SSE chunks → client receives `[REDACTED_MOCK_PII]`, valid framing, no fractured JSON.
3. PII in final holdback window → flush injected before terminal event.
4. MCP `initialize` → `tools/list` → `tools/call get_traffic_logs` works over all 3 transports.
5. Path-prefix, header, and heuristic routes each hit correct upstream.
6. Credit-card false positives killed by Luhn.

## 8. Risks

| Risk | Mitigation |
|---|---|
| PII fractured across chunks emitted before scrub | Holdback window + re-scan with context (FR5). |
| Greedy premature match on truncated stream text | Defer matches ending inside/spanning holdback. |
| Custom regex infinite loop | Zero-length-match guard; compile-once at startup. |
| Compressed upstream body unreadable | Force `accept-encoding: identity`. |
| stdio protocol corruption | All human logs → stderr. |

## 9. Rollout

Single file delivered + runbook (`newplan.md` §9). Manual verification script before delivery. No staged deploy — local tool.
