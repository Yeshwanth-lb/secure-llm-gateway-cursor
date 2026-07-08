# PII Redaction MCP Proxy

Tool-agnostic gateway that sits between any AI client and LLM providers
(OpenAI-compatible, Anthropic, Google Gemini). It **strips PII from outbound requests**
before they reach the provider and **strips PII from responses** before they reach the user,
while keeping a local audit trail with an optional push to a SIEM.

- **Data plane** — HTTP reverse proxy. Point your SDK's `base_url` at the gateway; no TLS MITM,
  no cert-trust install. Bidirectional, one-way masking (`John Smith` → `<PERSON>`).
- **Control plane** — MCP server for viewing logs/stats and managing rules + SIEM config.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and implementation plan.

## Status

🚧 Early stage — architecture defined, implementation in progress.

## Stack

Python · FastAPI · Presidio (spaCy NER + regex) · MCP (FastMCP) · SQLite (Postgres optional)
