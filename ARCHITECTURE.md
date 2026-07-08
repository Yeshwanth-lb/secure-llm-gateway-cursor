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
- **Providers vs clients** (distinct concepts):
  - **Providers = upstream wire formats**, one adapter each: **OpenAI-compatible**, **Anthropic**,
    **Google Gemini**.
  - **Clients = any app/SDK that overrides `base_url`** to point at the gateway: the OpenAI /
    Anthropic SDKs, **Cursor**, Continue, etc. Clients are **not** adapters — they ride the
    matching provider wire format. Cursor speaks OpenAI-compatible, so it rides `openai.py`;
    there is **no `cursor.py`**. See "Supported clients — Cursor" below.
- Redaction: **one-way strip/mask** — no reversible mapping store. **Bidirectional**: applied
  to the outbound request AND the inbound response (LLM-generated/hallucinated PII, e.g. a mock
  email, is masked to `<EMAIL_ADDRESS>` before the user sees it). No de-tokenize (one-way).
- Datastore: **SQLite** default (single node); Postgres as a config option for multi-replica.
- **Gateway auth**: bind **loopback-only (`127.0.0.1`) by default** — not an open network proxy.
  Optional gateway credential (`auth.gateway_keys`, bearer/API key) is **separate** from the
  upstream provider key it forwards. When bound to any **routable (non-loopback) interface**, a
  gateway key is **required** — requests without a valid one get `401`. Closes the open-proxy
  exposure without adding friction for local use.
- **Upstream key injection** (for single-key clients like Cursor): optional
  `providers[].api_key` in `config.yaml`.
  - **Off (default)** — client `Authorization`/`x-api-key` is forwarded upstream unchanged
    (multi-credential SDKs, loopback dev).
  - **On** — the client's single key is treated as the **gateway key** (validated against
    `auth.gateway_keys`); the gateway strips it and forwards the **server-held upstream key**
    instead. Lets a one-field client authenticate to the gateway *and* reach the provider behind a
    required gateway key. See data-plane flow step 6.
- **Coverage scope**: redaction covers **all text-bearing fields** — message content **and**
  tool/function-call arguments **and** structured JSON (JSON-mode / tool outputs) — not just
  named content fields. See adapters + data-plane flow.
- **Confidence threshold**: `redaction.min_confidence` (default `0.5`). Detections below it are
  handled per config (`redact` | `log_only`). Part of the fail-closed posture; residual NER
  false-negative risk is documented, not hidden.
- **Content-type policy**: only JSON bodies are redacted. `multipart/form-data` and other
  non-JSON bodies are **forwarded unredacted but emit a warning audit event** — never silent.

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

## Supported clients — Cursor

Cursor is a **client**, not a provider — it speaks the **OpenAI-compatible** wire format and rides
`openai.py`. No `cursor.py`.

**Setup:** Cursor → Settings → Models → **Override OpenAI Base URL** =
`http://localhost:8080/openai/v1`, API Key = the gateway key. Chat + tool calls then flow through
the OpenAI adapter and get **bidirectional redaction**. Same pattern for Anthropic/Gemini where
Cursor supports a custom key + base.

**Two Cursor realities the design must handle:**
1. **Single-key field.** Cursor exposes exactly one API-key field — it cannot send a separate
   gateway key and upstream key. Use **upstream key injection** (`providers[].api_key`, see Locked
   decisions): the one key Cursor sends is the gateway key; the gateway swaps in the server-held
   upstream key before forwarding. This is what lets Cursor work behind a required gateway key.
2. **Validation probe.** On save, Cursor calls `GET /v1/models` (and small probe completions) to
   verify the endpoint. Bodyless/`GET` requests **forward through untouched** (nothing to redact)
   and must return a valid response, or Cursor rejects the connection. The catch-all route matches
   arbitrary subpaths under the provider prefix (`/openai/v1/models`, `/openai/v1/chat/completions`).

**Limitation (stated plainly):** some Cursor features — **Tab**, and parts of **Agent/Composer** —
route through Cursor's own backend and **bypass the custom base URL**. The gateway only sees and
redacts traffic Cursor sends directly to the base URL; PII in bypassed features is **not** covered.

---

## Layout

```
MCP-PROXY/
  pyproject.toml
  README.md
  config/
    config.yaml            # server, providers (real base URLs + optional upstream api_key for
                           #   injection mode), auth (gateway_keys), datastore, siem toggle
    rules.yaml             # custom regex rules + enabled Presidio entities, filename rulesets
  src/pii_gateway/
    __init__.py
    cli.py                 # `serve` and `mcp` entrypoints
    config.py              # pydantic-settings load + validate config/rules
    proxy/
      app.py               # FastAPI app; catch-all route per provider prefix;
                           #   gateway-auth middleware; /health (live) + /ready (engine+DB);
                           #   body-size limit (413) + content-type gate
      forward.py           # httpx.AsyncClient forward
      stream.py            # SSE stream redactor: hold-back buffer, redacts response deltas
      adapters/
        base.py            # ProviderAdapter: target_url();
                           #   req: extract_texts(body)/reinject(body,texts)
                           #   resp: extract_resp_texts(body)/reinject_resp(body,texts)
                           #   stream: resp_stream_deltas(chunk) -> text spans in an SSE event
                           #   json_walk(obj): recursive redactor for free-form tool-arg /
                           #     JSON-mode payloads (depth+size bounded) — every string leaf
        openai.py          # req messages[].content, system, tool_calls[].function.arguments,
                           #   function_call.arguments, tool/function result messages
                           #   resp choices[].message.content + .tool_calls[].function.arguments,
                           #   JSON-mode content | stream choices[].delta.content + .tool_calls
        anthropic.py       # req messages[].content blocks (text + tool_use.input +
                           #   tool_result.content), system | resp content[].text +
                           #   tool_use.input | stream content_block_delta.text
        gemini.py          # req contents[].parts[].text + functionCall.args +
                           #   functionResponse.response, systemInstruction | resp
                           #   candidates[].content.parts[].text + functionCall.args (per chunk)
    redaction/
      engine.py            # RedactionEngine.redact(text) -> (clean_text, [events]); fail-closed
      presidio_setup.py    # AnalyzerEngine + AnonymizerEngine (spaCy en_core_web_lg)
      rules.py             # build custom PatternRecognizers from rules.yaml
    audit/
      store.py             # aiosqlite (WAL mode, busy_timeout, retry on SQLITE_BUSY);
                           #   write_event / query_events / stats; NEVER stores raw PII
      models.py            # RedactionEvent schema (incl. pre/post token estimates)
      siem/
        exporter.py        # bounded asyncio.Queue(maxsize) + background worker; fail-open,
                           #   retry w/ backoff; drop-oldest + dropped-count metric on overflow
        adapters.py        # SplunkHEC / Elastic / SyslogCEF formatters
    mcp/
      server.py            # FastMCP tools (control plane); read tier vs write tier;
                           #   write ops audited; atomic YAML writes; rules rollback
  tests/
    test_redaction.py  test_adapters.py  test_proxy.py  test_audit.py
```

---

## Data-plane flow (per request)

1. Client calls `http://gateway:8080/{provider}/...` with provider prefix (`openai`/`anthropic`/`gemini`).
   The catch-all route matches arbitrary subpaths under the prefix
   (`/openai/v1/chat/completions`, `/openai/v1/models`, …).
   - **Gateway auth**: middleware checks the gateway key (required on routable binds) → `401` on
     miss. **Size limit**: reject bodies over `limits.max_body_bytes` with `413`.
   - **Bodyless / non-JSON passthrough**: `GET`/bodyless requests (e.g. Cursor's `GET /v1/models`
     validation probe) and non-JSON bodies (e.g. `multipart/form-data`) **forward through with no
     redaction** (nothing to redact) and must return a valid response — non-JSON *bodies* emit a
     **warning audit event** (documented residual leak). **Bypass allowlist** (`bypass:`
     route/client-key/content-type) short-circuits redaction for dev/test fixtures — each bypass
     is itself logged as an audit event.
2. Route selects the matching `ProviderAdapter`.
3. Adapter `extract_texts(body)` pulls every text-bearing field for that schema — user/system
   content **plus** tool/function-call arguments, and `json_walk()` over free-form JSON leaves.
4. `RedactionEngine.redact()` on the batched fields → cleaned text + redaction events.
   - **Fail-closed** covers: analyzer raises, `reinject()` fails, or a detection below
     `min_confidence` under `redact` policy → return an error, **never forward unredacted**.
     (Enforce spaCy `max_length` + per-request redaction timeout here too.)
5. Adapter `reinject()` writes cleaned text back into the body.
6. `forward.py` sends cleaned body to the real provider base URL (from `config.yaml`). **Two
   forwarding modes** (see Locked decisions → upstream key injection):
   - **Injection off (default)**: pass the client's upstream `Authorization`/`x-api-key` header
     through unchanged (multi-credential SDKs, loopback dev).
   - **Injection on (single-key clients, e.g. Cursor)**: the client's single key is the gateway
     key — validate it, strip it, and forward the **server-held `providers[].api_key`** upstream.
   The gateway key is never forwarded either way.
7. **Response redaction (bidirectional requirement):**
   - **Non-stream**: adapter `extract_resp_texts` (content **+ tool-call args + JSON leaves**) →
     `RedactionEngine.redact` → `reinject_resp` → return cleaned body. LLM-generated PII (e.g. mock
     email) becomes `<EMAIL_ADDRESS>`; structured tool/JSON-mode outputs are walked too.
   - **Stream (SSE)**: `stream.py` runs a per-response **hold-back buffer**. For each SSE event,
     the adapter yields the text delta; deltas are accumulated, redaction runs on the buffer, the
     **safe prefix** (everything except a tail sized `stream.tail_bytes`, long enough to hold a
     partial PII match) is emitted as a rewritten SSE event, and the tail is held until the next
     delta or stream end. This masks PII even when a value spans chunk boundaries.
     **Latency tradeoff (documented)**: the tail adds up to one delta of lag and a small flush
     stutter at stream end; `stream.tail_bytes` tunes it, and a **fast path skips buffering** when
     no enabled pattern could match the pending tail. Non-text SSE events (role, usage, `[DONE]`)
     pass through untouched.
8. Write one `RedactionEvent` to SQLite with **separate request/response category counts**
   (e.g. `req={EMAIL:3}`, `resp={EMAIL:1}`), rules fired, latency_ms, status, and **pre/post
   token estimates** (redaction changes token count → provider-reported usage reflects the
   redacted body; recording both makes the divergence auditable).
   **Raw PII values are never written** — categories + counts only.
9. If `siem.enabled`, enqueue the event for the background exporter (non-blocking).

The **same `RedactionEngine`** serves both directions — no duplicate detection logic.

### Redaction engine
- Presidio `AnalyzerEngine` (spaCy `en_core_web_lg`) for built-ins: PERSON, EMAIL_ADDRESS,
  PHONE_NUMBER, CREDIT_CARD, US_SSN, IP_ADDRESS, LOCATION, etc.
- Custom `PatternRecognizer`s built from `rules.yaml` — internal hostnames, employee IDs,
  project codenames, and a **filename category** with separate internal vs external rulesets.
- `AnonymizerEngine` replaces spans one-way with `<TYPE>` placeholders. No mapping stored.
- **Performance**:
  - `redaction.spacy_model` selects `en_core_web_lg` (accuracy) or `en_core_web_sm` (speed) —
    ~700MB/higher latency vs lighter/faster. Explicit accuracy/latency tradeoff.
  - **Batch** all text fields of a request into one analyze pass, not one call per field.
  - Pipeline is **warmed once at startup** and reused (no per-request load).
- Presidio/spaCy is CPU-bound sync → run `redact()` in a threadpool (`anyio.to_thread.run_sync`)
  so the event loop is not blocked. Config `redaction.workers` for pool size; a **bounded work
  queue** fronts the pool — at saturation the gateway returns `503` rather than piling up
  unboundedly.

### SIEM exporter (opt-in)
- Config: `siem: { enabled: false, target: splunk|elastic|syslog, endpoint, format, max_queue }`.
- **Bounded** `asyncio.Queue(maxsize=max_queue)` + background task; **fail-open** (SIEM down never
  blocks/delays the LLM call; retry with backoff). On overflow (SIEM unreachable for a long time),
  **drop-oldest** and increment a `siem_dropped` counter surfaced in stats — no unbounded memory
  growth. Contrast: redaction is **fail-closed**.
- Adapters: Splunk HEC (POST JSON), Elastic bulk API, generic syslog CEF (covers Sentinel/QRadar/ArcSight).

---

## Control plane — MCP tools (`mcp/server.py`, FastMCP)

Tools split into two tiers. **The MCP server is driven by an AI model, so it is a
prompt-injection surface** — a poisoned prompt could try to call a write tool to silently
disable detection. Mitigations below.

**Read tier** (safe, no side effects):
- `get_logs(filters)` — query audit events (provider, time window, category).
- `get_redaction_stats(window)` — aggregate counts per category / provider / rule; includes
  `siem_dropped`.
- `list_rules()` — current rules + versions.
- `get_config()` — current config with secrets redacted.

**Write tier** (gated): requires an explicit confirmation flag (`confirm=true`) / operator authz,
and **every call appends a row to an audit change-log** (who/what/before→after):
- `configure_rules(add|remove pattern)` — **validates the regex compiles and rejects
  catch-all/over-broad patterns** before write; edits `rules.yaml` **atomically** (write-tmp →
  `os.rename`, under a file lock); backs up the prior version (timestamped); then hot-reload.
- `rollback_rules(version?)` — restore the previous (or a named) `rules.yaml` version.
- `reload_rules()` — rebuild recognizers **fully, then swap under a lock (RCU-style)** — no
  partially-updated engine window.
- `configure_siem_export(enabled, target, endpoint, format, max_queue)` — atomic write; secrets
  never echoed.

Regex validation needs only `re.compile` — the MCP process does **not** load Presidio/spaCy, so
it stays light (no ~700MB). Reuse the same `config.py`, `audit/store.py`, and `redaction/rules.py`
modules — no duplicate logic.

---

## Datastore concurrency (two processes, one DB)
- `serve` (frequent event writes) and `mcp` (occasional config writes) share `gateway.db`.
- **WAL mode required** + `busy_timeout` set + **retry on `SQLITE_BUSY`** in `store.py` so
  write-write contention degrades gracefully instead of erroring.
- Health of the DB is part of `/ready`.

## Multi-network / HA (config options, not extra code paths)
- Proxy is **stateless** → run N replicas behind a load balancer with a stable DNS name
  (LB uses `/health` + `/ready`).
- For >1 replica needing shared logs/config, set datastore to **Postgres** (same `store.py` interface).
- `config/` mounted from a shared source; `reload_rules()` picks up changes.

---

## Verification

**Unit**
- `test_redaction.py` — feed strings containing fake email/SSN/phone/custom-codename; assert PII
  gone from output and correct events emitted; assert analyzer failure ⇒ raises (fail-closed).
- `test_adapters.py` — for each provider, assert request AND response extract/reinject round-trip
  the schema and touch every text field (messages, system, choices/content/candidates, stream
  deltas) **plus tool/function-call arguments and free-form JSON leaves** (`json_walk`).
- `test_proxy.py` — mock upstream with `respx`; send a request with PII; assert **upstream received
  the redacted body** and the original upstream auth header. Mock an upstream response containing a
  fake email/SSN; assert the client receives it **masked**. Test the SSE hold-back buffer with PII
  split across two chunks — assert it is masked in the emitted stream. Also assert: **gateway-auth
  401**, **413 over size limit**, non-JSON **passthrough + warning event**, `min_confidence`
  behavior, and the pool-saturation **503**.
- `test_audit.py` — assert an event row is written with counts and **no raw PII**; stats aggregate;
  SIEM **bounded-queue drop** increments `siem_dropped`.
- `test_mcp.py` — write-tier requires `confirm`; `configure_rules` rejects a bad/over-broad regex,
  writes atomically, and `rollback_rules` restores the prior version; every write logs a change-row.
- `test_clients.py` — **Cursor path**: `GET /openai/v1/models` proxies with `200` and **no
  redaction** (validation probe); **injection mode** swaps the client key for the server-held
  upstream key on forward, and a **bad gateway key returns `401`**.

**End-to-end (automated)** — `test_e2e.py` boots the real `pii-gateway serve` process against a
fake upstream, sends real HTTP (both directions, stream + non-stream, a tool-call payload, and a
bodyless `GET /models` probe), and asserts end-to-end masking. Runs in CI; not manual-only.

**End-to-end (manual smoke)**
1. Start a fake echo upstream + `pii-gateway serve` pointed at it.
2. Use the real OpenAI Python SDK with `base_url=http://localhost:8080/openai/v1`; send a message
   containing a fake SSN + email.
3. Confirm the echo upstream received a body with `<US_SSN>` / `<EMAIL_ADDRESS>`, not raw values.
   Make the echo upstream reply with a mock email in its content; confirm the **client sees
   `<EMAIL_ADDRESS>`**, not the raw mock email (response redaction). Repeat with `stream=True`.
4. Run `pii-gateway mcp`; call `get_logs` → see the event (categories only); call `get_redaction_stats`.
5. Toggle `configure_siem_export` to a local mock HEC endpoint; confirm export fires and that
   killing the mock does **not** block a subsequent LLM call (fail-open).
6. **Cursor**: set Override OpenAI Base URL = `http://localhost:8080/openai/v1` + gateway key
   (injection mode on). Confirm the connection validates (`GET /models` probe passes), then send a
   chat containing a fake SSN/email from Cursor — confirm the upstream received redacted text and
   Cursor renders a redacted streamed response.

---

## Build order
1. `config.py` + config/rules schemas (incl. `auth`, `providers[].api_key` injection, `limits`,
   `redaction.min_confidence`, `redaction.spacy_model`, `stream.tail_bytes`, `bypass`,
   `siem.max_queue`).
2. `redaction/` (engine + presidio + custom rules, batching, warmup) with unit tests — core value.
3. `proxy/adapters/` (request + response + stream delta + tool-arg/`json_walk`) + `forward.py`
   (**two forwarding modes: key passthrough vs upstream-key injection**) + `stream.py` (hold-back
   buffer + fast path) + `app.py` (**gateway auth, `/health`+`/ready`, size limit, content-type
   gate, bodyless/`GET` passthrough for Cursor's `/models` probe, bypass**); wire bidirectional
   redaction; proxy tests.
4. `audit/store.py` (SQLite **WAL + busy_timeout + retry**) + event writing (pre/post tokens).
5. `mcp/server.py` control-plane tools (**read/write tiers, atomic writes, rollback, change-log**).
6. `audit/siem/` exporter + adapters (opt-in, **bounded queue + drop metric**).
7. Automated `test_e2e.py` + manual smoke + README.

---

## Resolved review findings

| Severity | Pain point | Where addressed |
|---|---|---|
| High | No gateway auth (open proxy) | Locked decisions (gateway auth); flow step 1; `app.py` middleware |
| High | Tool/function-call args bypass redaction | Coverage scope; adapters (`json_walk`, tool-arg paths); flow steps 3/7 |
| High | MCP write tools = injection surface | Control plane read/write tiers; `confirm` + authz + change-log |
| High | Streaming hold-back lag | Flow step 7 (`stream.tail_bytes`, latency note, fast path) |
| Med | SQLite write contention | Datastore concurrency (WAL + busy_timeout + retry) |
| Med | No confidence threshold / false negatives | `redaction.min_confidence`; widened fail-closed (flow step 4) |
| Med | Unbounded SIEM queue | SIEM exporter (bounded queue, drop-oldest, `siem_dropped`) |
| Med | Structured JSON / tool outputs uncovered | `json_walk` recursive walker; adapters resp paths; flow step 7 |
| Med | No rules rollback / versioning | `rollback_rules`, timestamped backups, change-log |
| Low | No /health endpoint | `app.py` `/health` + `/ready`; used by LB + `/ready` DB check |
| Low | Token count divergence | `RedactionEvent` pre/post token estimates (flow step 8) |
| Low | No request size limits | `limits.max_body_bytes` → 413; spaCy `max_length` + timeout guard |
| — | Multipart / non-JSON bodies | Content-type policy (passthrough + warning event) |
| — | `reload_rules()` non-atomic | Build-then-swap under lock (RCU) |
| — | No bypass/allowlist | `bypass:` config (route/client/content-type), each logged |
| — | Presidio in MCP process? | MCP validates via `re.compile` only — no spaCy load |
| — | E2E tests thin | Automated `test_e2e.py` in CI |
