# Secure LLM Gateway Proxy — Implementation Plan

**Deliverable:** `secure-llm-gateway.ts` — a single-file, zero-runtime-dependency TypeScript application (Node.js ≥ 22 built-ins only: `node:http`, `node:https`, `node:crypto`, `node:readline`, `node:fs`, `node:url`). Runs immediately with `node --experimental-strip-types secure-llm-gateway.ts` (or `npx tsx secure-llm-gateway.ts` on older Node).

**Listen address:** `http://127.0.0.1:8000` (configurable via `GATEWAY_HOST` / `GATEWAY_PORT`).

---

## 1. Architecture Overview

```
IDE / Agent (Cursor, Claude Code, LangChain, AutoGen)
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│  localhost:8000  —  Secure LLM Gateway (single process) │
│                                                         │
│  ┌───────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │  Router    │→│ Redaction Engine │→│ Upstream Fwd │  │
│  │ (path/hdr) │  │ inbound scrub    │  │ http/https   │  │
│  └───────────┘  └──────────────────┘  └──────┬───────┘  │
│        ▲                                     │          │
│  ┌─────┴──────┐  ┌──────────────────┐        ▼          │
│  │ Ring-buffer│←─│ SSE / JSON       │←── LLM response   │
│  │ traffic log│  │ outbound scrub   │                   │
│  │ (last 100) │  └──────────────────┘                   │
│  └─────┬──────┘                                         │
│        │  ┌──────────────────────────────────────────┐  │
│        └─→│ MCP Server  /mcp  (JSON-RPC 2.0)          │  │
│           │ • Streamable HTTP (POST /mcp)             │  │
│           │ • Legacy HTTP+SSE (GET /mcp → endpoint    │  │
│           │   event → POST /mcp/messages?sessionId=…) │  │
│           │ • stdio transport (--stdio flag)          │  │
│           │ • tool: get_traffic_logs                  │  │
│           └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
        │                    │                    │
        ▼                    ▼                    ▼
 api.anthropic.com   generativelanguage    OpenAI/Cursor-
                      .googleapis.com      compatible base
```

Single process, no framework — raw `http.createServer` for maximum performance and zero supply-chain surface. All shared state (log ring buffer, MCP sessions, redaction rules) lives in-process, so the MCP tool reads live traffic data.

---

## 2. Provider Routing Matrix

Resolution order (first match wins):

| Priority | Signal | Route |
|---|---|---|
| 1 | Path prefix `/anthropic/*`, `/gemini/*`, `/openai/*` (prefix stripped before forwarding) | Explicit |
| 2 | Header `x-llm-provider: anthropic \| gemini \| openai` | Explicit |
| 3 | Path `/v1/messages`, `/v1/complete` | Anthropic |
| 3 | Path `/v1beta/*`, `/v1alpha/*`, or contains `:generateContent`, `:streamGenerateContent`, `:countTokens` | Gemini |
| 3 | Path `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/responses` | OpenAI-compatible |
| 4 | Header sniff: `anthropic-version` or `x-api-key` → Anthropic; `x-goog-api-key` → Gemini; `Authorization: Bearer` → OpenAI-compatible | Fallback (covers ambiguous paths like `/v1/models`) |
| 5 | No match → `404` with a JSON hint explaining routing options | — |

**Upstream bases** (env-overridable):
- `ANTHROPIC_UPSTREAM` → `https://api.anthropic.com`
- `GEMINI_UPSTREAM` → `https://generativelanguage.googleapis.com`
- `OPENAI_COMPAT_UPSTREAM` → `https://api.openai.com` (point this at any Cursor/Anyscale/vLLM-compatible base)
- Per-request override header `x-llm-upstream: https://…` for pass-through to arbitrary OpenAI-compatible endpoints.

**Header forwarding:** all client headers are copied verbatim — including `x-api-key`, `Authorization`, `x-goog-api-key`, `anthropic-version`, `anthropic-beta` — except hop-by-hop/transport headers (`host`, `connection`, `content-length`, `transfer-encoding`, `accept-encoding`, `keep-alive`, `te`, `upgrade`, `proxy-*`). `accept-encoding: identity` is forced upstream so response bodies arrive uncompressed and can be inspected. `content-length` is recomputed after redaction. Auth headers are **never** redacted — redaction applies to bodies only.

---

## 3. Bidirectional PII Redaction Engine

### 3.1 Rules
`RedactionRule = { name, pattern: RegExp, validate?: (match) => boolean }`

Default set:
| Rule | Notes |
|---|---|
| `API_KEY` | `sk-…`, `sk-ant-…`, `AKIA…` (AWS), `AIza…` (Google), `ghp_/gho_` (GitHub), `xox…` (Slack) |
| `BEARER_TOKEN` | `Bearer <token≥16 chars>` appearing in payloads |
| `EMAIL` | RFC-pragmatic pattern with TLD requirement |
| `CREDIT_CARD` | 13–19 digits with optional space/dash separators, **validated with a Luhn checksum** to kill false positives |
| `SSN` | `ddd-dd-dddd` |
| `IPV4` | Strict octet ranges (0–255) |
| `IPV6` | Full and `::`-compressed groups (min 4 groups uncompressed to avoid matching clock times) |

Custom rules merge **ahead of** defaults (they win overlap resolution) from either:
- `CUSTOM_REGEX_RULES` env var — JSON array: `[{"name":"EMPLOYEE_ID","pattern":"EMP-\\d{6}","flags":"gi"}]`
- `CUSTOM_REGEX_RULES_FILE` env var — path to a JSON file with the same shape.

### 3.2 Match resolution
All rules are executed against the text; matches are sorted by start position (longest-first on ties) and overlaps are dropped (first/longest wins). Each replacement is recorded per-rule into the traffic-log entry's `matchedRules` map.

### 3.3 Direction semantics
- **Inbound (User → LLM):** every string value in the request JSON is deep-walked and scrubbed to `[REDACTED_PII_<TYPE>]` (e.g. `[REDACTED_PII_EMAIL]`) **before** any byte leaves the machine. Non-JSON text bodies are scrubbed as raw text.
- **Outbound (LLM → User):** response text (buffered JSON or SSE deltas) is scrubbed to `[REDACTED_MOCK_PII]` — blocking synthetic/mocked PII the model generates.

### 3.4 Streaming (SSE) without fracturing strings — the hard part
Naïve per-chunk regexing breaks when PII spans chunk boundaries (`"john.d"` … `"oe@example.com"`). Design:

1. **SSE event framing:** a stateful buffer accumulates raw bytes and only processes complete events (split on `\r?\n\r?\n`); the incomplete tail is retained. `event:`, `id:`, `retry:` and comment lines are preserved; multi-`data:` lines are joined per spec.
2. **Text-channel extraction:** each event's `data:` JSON is parsed and the provider's text delta is located by known paths — Anthropic `delta.text` / `content_block.text`, OpenAI `choices[].delta.content` / `choices[].text`, Gemini `candidates[].content.parts[].text`. Non-text string fields (e.g. Anthropic `partial_json` tool args) get stateless scrubbing per event.
3. **Rolling holdback redactor (`StreamRedactor`):** extracted text deltas feed one logical text channel. On each push, `tail + newText` is scanned; matches ending inside the final *holdback window* (default 96 chars, `STREAM_HOLDBACK_CHARS`) — or spanning it — are **deferred**, not emitted: the emit boundary is pulled back to the match start. The withheld raw tail is re-scanned with more context on the next chunk. This guarantees a match split across N chunks is still caught, and avoids premature greedy matches on truncated text.
4. **Flush injection:** withheld tail characters are released when the stream terminates. Terminal signals: Anthropic `content_block_stop`/`message_stop`, OpenAI `finish_reason` / `[DONE]`, Gemini `finishReason`. If the terminal event itself carries text (Gemini), the flush is appended into that event; otherwise a synthetic delta event is emitted **before** the terminal event, cloned from the last-seen delta event's structure so clients parse it natively. Nothing is ever dropped and event ordering stays valid.
5. Rewritten events are re-serialized with recomputed `data:` payloads; the client sees a byte-different but protocol-identical stream in real time (no whole-response buffering).
6. Gemini's non-SSE `streamGenerateContent` (JSON-array mode, no `alt=sse`) is buffered and scrubbed as JSON — correctness over stream latency; documented, with `alt=sse` recommended.

Non-streaming responses: fully buffered, deep-walked, `content-length` recomputed.

---

## 4. Traffic Log (ring buffer, last 100)

Per proxied request:
```json
{
  "id": "uuid",
  "timestamp": "ISO-8601",
  "provider": "anthropic | gemini | openai",
  "method": "POST", "path": "/v1/messages", "status": 200,
  "streaming": true, "durationMs": 1234,
  "charCount": { "request": 812, "response": 2440, "total": 3252 },
  "payloadSnapshot": { "request": "first 500 redacted chars…", "response": "first 500 redacted chars…" },
  "piiDetected": true,
  "matchedRules": { "inbound": { "EMAIL": 2 }, "outbound": { "CREDIT_CARD": 1 } }
}
```
Snapshots are stored **post-redaction** — the log itself never persists raw PII. Capacity-100 FIFO. Also exposed at `GET /logs` for quick human inspection, plus `GET /healthz` and `GET /rules` (active rule names/sources).

---

## 5. Integrated MCP Server (`/mcp`)

Formal JSON-RPC 2.0, three transports sharing one dispatcher:

1. **Streamable HTTP:** `POST /mcp` with a JSON-RPC message (or batch) → `application/json` response; notifications → `202`. `Mcp-Session-Id` issued on `initialize`. `DELETE /mcp` terminates.
2. **Legacy HTTP+SSE** (Cursor / Claude Desktop compatible): `GET /mcp` (Accept: `text/event-stream`) opens the stream and sends the `endpoint` event → `data: /mcp/messages?sessionId=<uuid>`; `POST /mcp/messages?sessionId=…` returns `202 Accepted` and the JSON-RPC response is delivered over the SSE stream. 15-second `: ping` heartbeats; session cleanup on disconnect.
3. **stdio:** launch with `--stdio` (or `MCP_STDIO=1`) — newline-delimited JSON-RPC on stdin/stdout, diagnostics on stderr. The HTTP proxy still starts in the same process, so `get_traffic_logs` reads live data.

**Methods:** `initialize` (protocol version negotiation, `capabilities: { tools: {} }`, `serverInfo`), `notifications/initialized`, `ping`, `tools/list`, `tools/call`, empty `resources/list` / `prompts/list` for host compatibility, `-32601` otherwise.

**Tool:**
```json
{
  "name": "get_traffic_logs",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Max entries, 1–100 (default 100)" },
      "filter_redacted": { "type": "boolean", "description": "Only entries where PII was detected" }
    },
    "additionalProperties": false
  }
}
```
Returns `content: [{ type: "text", text: <pretty-printed JSON of entries, newest first> }]` with the exact fields from §4.

---

## 6. Request Lifecycle (end to end)

1. Accept request → CORS preflight short-circuit → route to MCP handler, admin endpoint, or proxy.
2. Proxy: read body (25 MB cap) → resolve provider → create log entry.
3. Inbound scrub (deep-walk JSON / raw text) → record matches + snapshot.
4. Forward via `http/https.request` with cleaned headers, recomputed `content-length`.
5. Response: `text/event-stream` → SSE pipeline streamed live through the holdback redactor; JSON/text → buffer, scrub, recompute length; binary → raw pass-through.
6. Finalize log entry (status, duration, char counts, outbound matches). Upstream failure → `502` JSON error, logged.

---

## 7. Error Handling & Hardening

- Body size cap (`413`), upstream connect/read errors (`502` with detail), malformed JSON bodies degrade gracefully to raw-text scrubbing.
- Binds to `127.0.0.1` by default (not `0.0.0.0`) — local-only perimeter.
- No `eval`, no dynamic code, no third-party packages; custom regexes are compiled once at startup with clear failure messages.
- Zero-length regex match guard (prevents infinite `exec` loops on bad custom rules).
- In stdio mode all human-readable logging goes to stderr (stdout is protocol-pure).

## 8. Verification Plan (executed before delivery)

1. Local fake upstream on `:9101` (JSON + SSE modes).
2. Inbound test: request containing email/SSN/CC/API-key → assert upstream receives `[REDACTED_PII_*]` tokens.
3. Outbound streaming test: upstream splits an email **mid-string across SSE chunks** → assert client receives `[REDACTED_MOCK_PII]` with no fractured JSON and valid SSE framing.
4. Terminal-flush test: PII in the final holdback window → assert flush injection before `[DONE]`/`message_stop`.
5. MCP: `initialize` → `tools/list` → `tools/call get_traffic_logs` (with `limit` and `filter_redacted`) over Streamable HTTP; `endpoint` event over legacy SSE; stdio round-trip.
6. Routing: path-prefix, header, and heuristic routes each hit the right upstream base.

## 9. Runbook

```bash
# Node ≥ 22.6
node --experimental-strip-types secure-llm-gateway.ts
# or, any Node ≥ 18:
npx tsx secure-llm-gateway.ts
# MCP over stdio (for Claude Desktop / Cursor "command" servers):
node --experimental-strip-types secure-llm-gateway.ts --stdio

# Point clients at it:
#   Anthropic SDK:  ANTHROPIC_BASE_URL=http://localhost:8000
#   OpenAI SDK:     OPENAI_BASE_URL=http://localhost:8000/v1
#   Gemini:         http://localhost:8000/gemini/…  (or default heuristics)
# MCP host config:  { "url": "http://localhost:8000/mcp" }
```