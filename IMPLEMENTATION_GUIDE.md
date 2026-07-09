# Implementation Guide — Secure LLM Gateway Proxy

**Deliverable:** `secure-llm-gateway.ts` (single file, zero deps). See `newplan.md` for full design, `PRD.md` for requirements.

**Team:** Mohit Sahoo, Yeshwanth
**Model:** Both edit one file. To avoid collisions, each phase names an owner + a **frozen contract** (interfaces the other side codes against). Build interfaces first, then fill in parallel.

---

## Contracts (agree before coding — both own)

These type signatures are the seams between the two workstreams. Lock them in Phase 0; do not change without both agreeing.

```ts
type Provider = "anthropic" | "gemini" | "openai";

interface RouteResult {
  provider: Provider;
  upstreamBase: string;   // resolved base URL
  forwardPath: string;    // path after prefix-strip
}

interface RedactionRule {
  name: string;
  pattern: RegExp;
  validate?: (match: string) => boolean;   // e.g. Luhn for CREDIT_CARD
}

// direction picks the token: inbound -> [REDACTED_PII_<TYPE>], outbound -> [REDACTED_MOCK_PII]
type Direction = "inbound" | "outbound";
interface RedactResult { text: string; matched: Record<string, number>; }
function redactText(text: string, dir: Direction): RedactResult;
function redactJson(obj: unknown, dir: Direction): { value: unknown; matched: Record<string,number> };

interface LogEntry { /* exact shape from newplan.md §4 */ }
const trafficLog: {
  push(e: LogEntry): void;
  recent(limit: number, filterRedacted: boolean): LogEntry[];
};

// StreamRedactor: outbound SSE. Owner: Mohit. Consumers: proxy pipeline.
class StreamRedactor {
  constructor(provider: Provider, holdback: number);
  push(rawChunk: Buffer): Buffer;   // returns rewritten bytes ready to send (may be empty)
  flush(): Buffer;                  // release withheld tail at stream end
}
```

**Rule:** commit the contracts block first. Everything else compiles against it.

---

## Phase 0 — Skeleton & contracts  *(pair, ~0.5 day)*
**Owner:** Mohit + Yeshwanth together.

- Create `secure-llm-gateway.ts`, imports (`node:http/https/crypto/readline/fs/url`).
- `http.createServer` bootstrap binding `127.0.0.1:8000` (`GATEWAY_HOST`/`GATEWAY_PORT`).
- Config loader: env upstreams, `STREAM_HOLDBACK_CHARS`, body cap.
- Paste the Contracts block above as real stubs (throw "not impl").
- `GET /healthz` returns 200 (smoke test the loop).

**Exit:** file runs, `/healthz` responds, both stubs typecheck.

---

## Workstream A — Mohit (Redaction + Streaming)

The hard correctness core. `newplan.md` §3.

### Phase A1 — Redaction rules & engine
- 7 default `RedactionRule`s (§3.1). Luhn `validate` for CREDIT_CARD.
- Custom-rule loader: `CUSTOM_REGEX_RULES` (JSON) + `CUSTOM_REGEX_RULES_FILE`, merged **ahead of** defaults. Compile once, clear failure messages. Zero-length-match guard.
- Match resolution (§3.2): run all rules, sort by start (longest-first on ties), drop overlaps, count per rule.
- Implement `redactText` + `redactJson` (deep-walk every string value).

**Exit:** unit-scrub an object with email/SSN/CC/api-key → correct tokens + counts; a non-Luhn 16-digit number is left alone.

### Phase A2 — StreamRedactor (holdback core)
- SSE event framing: stateful buffer, split on `\r?\n\r?\n`, retain incomplete tail, preserve `event:/id:/retry:`/comments, join multi-`data:`.
- Text-channel extraction per provider (Anthropic `delta.text`/`content_block.text`, OpenAI `choices[].delta.content`/`text`, Gemini `candidates[].content.parts[].text`). Stateless scrub for non-text string fields (e.g. `partial_json`).
- Rolling holdback: on push, scan `tail + newText`; defer matches ending inside/spanning the holdback window; pull emit boundary to match start; re-scan withheld tail next chunk.
- Flush injection at terminal signals (Anthropic `content_block_stop`/`message_stop`, OpenAI `finish_reason`/`[DONE]`, Gemini `finishReason`). If terminal event carries text (Gemini) append into it; else synthetic delta cloned from last delta event, emitted **before** terminal.
- Re-serialize events with recomputed `data:`.
- Gemini non-SSE array mode → buffer + JSON scrub (documented fallback).

**Exit:** feed a synthetic SSE stream splitting an email across 3 chunks → output has `[REDACTED_MOCK_PII]`, valid framing, nothing dropped; PII in final window flushed before terminal.

**Depends on:** A1 (`redactText`). Contract lets Yeshwanth wire the pipeline before A2 is done — `StreamRedactor` stub passes bytes through until filled.

---

## Workstream B — Yeshwanth (Routing + Proxy + Log + MCP)

The plumbing and observability. `newplan.md` §2, §4, §5, §6.

### Phase B1 — Routing + header forwarding
- `resolveRoute(req): RouteResult` — 5-tier resolution (§2), first match wins. 404 JSON hint on no match.
- Header forwarding: copy verbatim except hop-by-hop set; force `accept-encoding: identity`; `x-llm-upstream` override; auth headers untouched.

**Exit:** unit — each of prefix/header/heuristic/sniff inputs maps to the right `RouteResult`.

### Phase B2 — Proxy pipeline + traffic log
- Request lifecycle (§6): body read w/ 25 MB cap (413) → `resolveRoute` → create `LogEntry`.
- Inbound: call `redactJson`/`redactText` (Mohit's A1), record matches + snapshot.
- Forward via `http/https.request`, cleaned headers, recomputed `content-length`.
- Response branch: `text/event-stream` → pipe through `StreamRedactor` (Mohit A2); JSON/text → buffer + scrub + recompute length; binary → raw passthrough.
- Finalize `LogEntry` (status, durationMs, charCount, outbound matched). Upstream error → 502 JSON, logged.
- `trafficLog` ring buffer (100 FIFO), post-redaction snapshots only.
- Admin: `GET /logs`, `/rules` (active names+sources), `/healthz`. CORS preflight short-circuit.

**Exit:** end-to-end request against a fake upstream logs an entry with correct char counts + matched rules; snapshot contains no raw PII.

### Phase B3 — MCP server (3 transports)
- One JSON-RPC 2.0 dispatcher. Methods: `initialize` (version negotiation, `capabilities.tools`, `serverInfo`), `notifications/initialized`, `ping`, `tools/list`, `tools/call`, empty `resources/list`/`prompts/list`, else `-32601`.
- Transport 1 Streamable HTTP: `POST /mcp` → `application/json`; notifications → 202; `Mcp-Session-Id` on init; `DELETE /mcp` terminates.
- Transport 2 legacy HTTP+SSE: `GET /mcp` → `endpoint` event `data: /mcp/messages?sessionId=<uuid>`; `POST /mcp/messages?sessionId=…` → 202, response over SSE; 15 s `: ping`; cleanup on disconnect.
- Transport 3 stdio: `--stdio`/`MCP_STDIO=1`, newline-delimited JSON-RPC stdin/stdout, diagnostics stderr, HTTP proxy still boots.
- Tool `get_traffic_logs` (schema §5) → reads `trafficLog.recent(limit, filter_redacted)`, returns pretty JSON text content.

**Exit:** `initialize`→`tools/list`→`tools/call get_traffic_logs` round-trips over all 3 transports; stdout stays protocol-pure in stdio mode.

---

## Phase C — Integration & verification  *(pair)*
**Owner:** both. `newplan.md` §8.

- Local fake upstream `:9101` (JSON + SSE modes) — build first, both use it.
- Run the 6 verification tests from PRD §7 / newplan §8.
- Hardening pass (§7): malformed-JSON→raw-text degrade, zero-length guard, 127.0.0.1 bind confirmed.
- Runbook smoke (§9): Anthropic/OpenAI/Gemini base-URL wiring, MCP host config.

**Exit:** all 6 acceptance criteria green.

---

## Dependency graph

```
Phase 0 (pair)
   ├── A1 (Mohit) ──► A2 (Mohit) ─┐
   └── B1 (Yesh) ──► B2 (Yesh) ───┤──► Phase C (pair)
                     B3 (Yesh) ───┘
```

Contracts let A and B run in parallel after Phase 0. B2 consumes A1's `redactText`/`redactJson` and A2's `StreamRedactor` — both start as passthrough stubs so Yeshwanth is never blocked; correctness lands when Mohit fills them.

## Suggested order / sync points

1. **Sync 1:** end of Phase 0 — contracts frozen.
2. Parallel: Mohit A1→A2, Yeshwanth B1→B2→B3.
3. **Sync 2:** A1 done → Yeshwanth swaps stub for real redaction in B2.
4. **Sync 3:** A2 done → wire real StreamRedactor into B2 SSE branch.
5. **Sync 4:** Phase C together.
