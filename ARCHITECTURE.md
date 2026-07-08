# PII Redaction Gateway — Architecture & Implementation Plan

## Context

Tool-agnostic gateway that sits between any AI client and LLM providers. It strips PII from
outbound requests before they reach the provider, strips PII from the responses before they
reach the user, and keeps a local audit trail with an optional push to a SIEM.

Two planes, one shared datastore:

- **Data plane** — HTTP reverse proxy. Client points its SDK `base_url` at the gateway; the
  gateway parses the request, strips PII, forwards the cleaned request to the real provider,
  then **strips PII from the response too** before returning it. Tool-agnostic because nearly
  every SDK allows a `base_url` override. **No TLS MITM / no cert-trust install** — explicit
  base_url routing only.
- **Control plane** — MCP server exposing tools to view logs, view redaction stats, and
  manage rules + SIEM config. Everything stays local in the gateway; SIEM export is opt-in.

### Locked decisions
- Runtime: **Python** — FastAPI + `uvicorn` (async), **Presidio** for PII detection.
- Providers (each an adapter): **OpenAI-compatible**, **Anthropic**, **Google Gemini**.
- Redaction: **one-way strip/mask** — no reversible mapping store. **Bidirectional**: applied
  to the outbound request AND the inbound response (LLM-generated/hallucinated PII, e.g. a mock
  email, is masked to `<EMAIL_ADDRESS>` before the user sees it). No de-tokenize (one-way).
- Datastore: **SQLite** default (single node); Postgres as a config option for multi-replica.

---

## Architecture

```
AI Tool/SDK  --base_url-->  [ HTTP Proxy : data plane ]  --forward-->  OpenAI / Anthropic / Gemini
                                    |
                                    v
                         [ Redaction Engine (Presidio + custom regex) ]
                                    |
                                    v
                         [ SQLite audit log ]  <-- shared -->  [ MCP server : control plane ]
                                    |
                                    v (opt-in, off by default)
                         [ SIEM exporter: Splunk HEC / Elastic / syslog-CEF ]
```

Data plane and control plane run as **two entrypoints sharing config + DB files** (clean split;
avoids mixing a network daemon with an MCP stdio server in one process):
- `pii-gateway serve` — long-running FastAPI proxy daemon.
- `pii-gateway mcp` — MCP stdio server (spawned by MCP client, e.g. Claude Desktop).

Both read `config/config.yaml`, `config/rules.yaml`, and `gateway.db`.

---

## Layout

```
MCP-PROXY/
  pyproject.toml
  README.md
  config/
    config.yaml            # server, providers (real base URLs), datastore, siem toggle
    rules.yaml             # custom regex rules + enabled Presidio entities, filename rulesets
  src/pii_gateway/
    __init__.py
    cli.py                 # `serve` and `mcp` entrypoints
    config.py              # pydantic-settings load + validate config/rules
    proxy/
      app.py               # FastAPI app; catch-all route per provider prefix
      forward.py           # httpx.AsyncClient forward
      stream.py            # SSE stream redactor: hold-back buffer, redacts response deltas
      adapters/
        base.py            # ProviderAdapter: target_url();
                           #   req: extract_texts(body)/reinject(body,texts)
                           #   resp: extract_resp_texts(body)/reinject_resp(body,texts)
                           #   stream: resp_stream_deltas(chunk) -> text spans in an SSE event
        openai.py          # req messages[].content, system | resp choices[].message.content,
                           #   stream choices[].delta.content
        anthropic.py       # req messages[].content blocks, system | resp content[].text,
                           #   stream content_block_delta.text
        gemini.py          # req contents[].parts[].text, systemInstruction | resp
                           #   candidates[].content.parts[].text (stream: same, per chunk)
    redaction/
      engine.py            # RedactionEngine.redact(text) -> (clean_text, [events]); fail-closed
      presidio_setup.py    # AnalyzerEngine + AnonymizerEngine (spaCy en_core_web_lg)
      rules.py             # build custom PatternRecognizers from rules.yaml
    audit/
      store.py             # aiosqlite; write_event / query_events / stats; NEVER stores raw PII
      models.py            # RedactionEvent schema
      siem/
        exporter.py        # asyncio.Queue + background worker; fail-open, retry w/ backoff
        adapters.py        # SplunkHEC / Elastic / SyslogCEF formatters
    mcp/
      server.py            # FastMCP tools (control plane)
  tests/
    test_redaction.py  test_adapters.py  test_proxy.py  test_audit.py
```

---

## Data-plane flow (per request)

1. Client calls `http://gateway:8080/{provider}/...` with provider prefix (`openai`/`anthropic`/`gemini`).
2. Route selects the matching `ProviderAdapter`.
3. Adapter `extract_texts(body)` pulls every user/system text field for that schema.
4. `RedactionEngine.redact()` on each field → cleaned text + redaction events.
   - **Fail-closed**: if the analyzer raises, return an error to the client — never forward unredacted.
5. Adapter `reinject()` writes cleaned text back into the body.
6. `forward.py` sends cleaned body to the real provider base URL (from `config.yaml`), passing the
   client's `Authorization`/`x-api-key` header through unchanged.
7. **Response redaction (bidirectional requirement):**
   - **Non-stream**: adapter `extract_resp_texts` → `RedactionEngine.redact` each field →
     `reinject_resp` → return cleaned body. LLM-generated PII (e.g. mock email) becomes `<EMAIL_ADDRESS>`.
   - **Stream (SSE)**: `stream.py` runs a per-response **hold-back buffer**. For each SSE event,
     the adapter yields the text delta; deltas are accumulated, redaction runs on the buffer, the
     **safe prefix** (everything except a tail long enough to hold a partial PII match) is emitted
     as a rewritten SSE event, and the tail is held until the next delta or stream end. This masks
     PII even when a value spans chunk boundaries, while preserving incremental streaming. Non-text
     SSE events (role, usage, `[DONE]`) pass through untouched.
8. Write one `RedactionEvent` to SQLite with **separate request/response category counts**
   (e.g. `req={EMAIL:3}`, `resp={EMAIL:1}`), rules fired, latency_ms, status.
   **Raw PII values are never written** — categories + counts only.
9. If `siem.enabled`, enqueue the event for the background exporter (non-blocking).

The **same `RedactionEngine`** serves both directions — no duplicate detection logic.

### Redaction engine
- Presidio `AnalyzerEngine` (spaCy `en_core_web_lg`) for built-ins: PERSON, EMAIL_ADDRESS,
  PHONE_NUMBER, CREDIT_CARD, US_SSN, IP_ADDRESS, LOCATION, etc.
- Custom `PatternRecognizer`s built from `rules.yaml` — internal hostnames, employee IDs,
  project codenames, and a **filename category** with separate internal vs external rulesets.
- `AnonymizerEngine` replaces spans one-way with `<TYPE>` placeholders. No mapping stored.
- Presidio/spaCy is CPU-bound sync → run `redact()` in a threadpool (`anyio.to_thread.run_sync`)
  so the event loop is not blocked. Config `redaction.workers` for pool size.

### SIEM exporter (opt-in)
- Config: `siem: { enabled: false, target: splunk|elastic|syslog, endpoint, format }`.
- `asyncio.Queue` + background task; **fail-open** (SIEM down never blocks/delays the LLM call;
  retry with backoff). Contrast: redaction is **fail-closed**.
- Adapters: Splunk HEC (POST JSON), Elastic bulk API, generic syslog CEF (covers Sentinel/QRadar/ArcSight).

---

## Control plane — MCP tools (`mcp/server.py`, FastMCP)
- `get_logs(filters)` — query audit events (provider, time window, category).
- `get_redaction_stats(window)` — aggregate counts per category / provider / rule.
- `list_rules()` / `configure_rules(add|remove pattern)` — edit `rules.yaml`, then hot-reload.
- `reload_rules()` — rebuild recognizers without restart.
- `configure_siem_export(enabled, target, endpoint, format)` — write config; secrets never echoed.
- `get_config()` — return current config with secrets redacted.

Reuse the same `config.py`, `audit/store.py`, and `redaction/rules.py` modules — no duplicate logic.

---

## Multi-network / HA (config options, not extra code paths)
- Proxy is **stateless** → run N replicas behind a load balancer with a stable DNS name.
- For >1 replica needing shared logs/config, set datastore to **Postgres** (same `store.py` interface).
- `config/` mounted from a shared source; `reload_rules()` picks up changes.

---

## Verification

**Unit**
- `test_redaction.py` — feed strings containing fake email/SSN/phone/custom-codename; assert PII
  gone from output and correct events emitted; assert analyzer failure ⇒ raises (fail-closed).
- `test_adapters.py` — for each provider, assert request AND response extract/reinject round-trip
  the schema and touch every text field (messages, system, choices/content/candidates, stream deltas).
- `test_proxy.py` — mock upstream with `respx`; send a request with PII; assert **upstream received
  the redacted body** and the original auth header. Mock an upstream response containing a fake
  email/SSN; assert the client receives it **masked**. Test the SSE hold-back buffer with PII split
  across two chunks — assert it is masked in the emitted stream.
- `test_audit.py` — assert an event row is written with counts and **no raw PII**; stats aggregate.

**End-to-end (manual)**
1. Start a fake echo upstream + `pii-gateway serve` pointed at it.
2. Use the real OpenAI Python SDK with `base_url=http://localhost:8080/openai/v1`; send a message
   containing a fake SSN + email.
3. Confirm the echo upstream received a body with `<US_SSN>` / `<EMAIL_ADDRESS>`, not raw values.
   Make the echo upstream reply with a mock email in its content; confirm the **client sees
   `<EMAIL_ADDRESS>`**, not the raw mock email (response redaction). Repeat with `stream=True`.
4. Run `pii-gateway mcp`; call `get_logs` → see the event (categories only); call `get_redaction_stats`.
5. Toggle `configure_siem_export` to a local mock HEC endpoint; confirm export fires and that
   killing the mock does **not** block a subsequent LLM call (fail-open).

---

## Build order
1. `config.py` + config/rules schemas.
2. `redaction/` (engine + presidio + custom rules) with unit tests — core value, de-risk first.
3. `proxy/adapters/` (request + response + stream delta methods) + `forward.py` + `stream.py`
   (hold-back buffer) + `app.py`; wire bidirectional redaction; proxy tests against mock upstream.
4. `audit/store.py` (SQLite) + event writing.
5. `mcp/server.py` control-plane tools.
6. `audit/siem/` exporter + adapters (opt-in).
7. E2E pass + README.
