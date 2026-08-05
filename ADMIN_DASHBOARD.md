# Admin Dashboard (Phase U)

A login-gated **admin control plane** for the gateway: analytics over PII decisions, per-surface
AI controls (kill switch, mode, PII-type toggles, fail-mode), and an append-only audit log.

Built **zero-dependency** like the rest of the gateway: `node:sqlite` for storage, `node:crypto`
(scrypt + HMAC JWT) for auth, and a server-rendered HTML dashboard (no React/build step). It runs
**inside the existing gateway process** — no separate service.

---

## Run it

```bash
# 1. Create the first admin (prompts for password, or use env)
ADMIN_USER=admin ADMIN_PASS='choose-a-strong-one' npm run admin:seed

# 2. Start the gateway as usual
npm start        # or: node scripts/gateway-service.mjs install

# 3. Open the dashboard
open http://127.0.0.1:8001/admin
```

- The dashboard binds to loopback only (like everything else). Log in with the seeded account.
- Add more admins by re-running `admin:seed` with a different `ADMIN_USER`.
- Turn the whole subsystem off with `GATEWAY_ADMIN=0`. Force it on (e.g. under the test runner)
  with `GATEWAY_ADMIN=1`.

### Config

| Env | Default | Meaning |
|---|---|---|
| `GATEWAY_ADMIN` | on (off under `--test`) | `0` disables the subsystem, `1` forces it on |
| `GATEWAY_ADMIN_DB` | `~/.secure-llm-gateway/admin.db` | SQLite file (inspect with `sqlite3`) |
| `GATEWAY_ADMIN_TOKEN` | unset | if set (≥8 chars), also used as the JWT signing secret; else a random key is persisted next to the DB (`jwt.key`, 0600) |

---

## What it shows (8 tabs)

- **Analytics** — event counts (today/7d/30d), redactions, blocks, active surfaces; an event-volume
  chart (filter by surface + decision), a PII-type breakdown, a per-surface table (volume, block
  rate, redaction rate, last-seen, health), and a CSV export of the filtered event log.
- **AI Controls** — per surface: master kill switch (confirm before disabling), mode selector
  (**only the modes a surface can do** — Cursor is block/allow only, never redact), fail-open/closed;
  plus **global PII-type toggles** that drive the live redaction engine (`setRuleEnabled`) across
  every surface immediately. **These are enforced** — see below.
- **Rules** — enable/disable each redaction rule on the live proxy; add/remove custom regex rules.
- **Allowlist** — patterns that are never redacted.
- **Model Policy** — block a model; the proxy 403s it (restricts Claude Code / SDK from within admin).
- **Traffic** — the live 100-entry inspector (post-redaction snapshots only).
- **Try Redaction** — paste text, preview what the engine strips (nothing stored).
- **Audit Log** — every control change, append-only, filterable by admin/action.

All 8 tabs are behind the admin JWT. Rules/Allowlist/Model Policy/Traffic/Try reuse the existing
control-plane logic (`handleControlApi`, the redaction engine, the traffic ring buffer) so the admin
console and the loopback console stay in lockstep; console mutations made here are audited.

## Enforcement (what "block" actually does)

- **Web surfaces (gemini/chatgpt/grok/deepseek):** the browser extension polls
  `GET /internal/config/:surface` (~every 15s, via its service worker). On a real send it checks the
  surface's admin policy **before** redacting:
  - **mode `block`** or the surface **disabled** → the send is stopped entirely on that site (the
    user is told "disabled by your administrator"). This is the "restrict the user" control — e.g.
    blocking Grok means grok.com won't send. Gemini covers gemini.google.com **and** the Workspace
    panels; blocking it blocks both.
  - **mode `off`** → redaction is disabled for that surface (raw sends proceed).
  - **mode `redact`** (default) → normal redaction.
- **Claude Code / SDK (proxy):** use **Model Policy** — a blocked model is 403'd at the proxy, so
  the request never leaves the machine.
- **Cursor:** block/allow only (its hooks can't rewrite); enforced by the Cursor hook path.

---

## How it plugs into the gateway

- **Routing:** `src/server.ts` gained a `GET /admin` block (the HTML shell) and a dispatch to
  `handleAdminApi` for `/admin/api/*` (JWT-gated) and `/internal/*` (loopback-gated). Both prefixes
  were added to the existing control-plane origin gate.
- **Data:** every decision the gateway already logs (`trafficLog.push` — proxy, `/redact`,
  `/log-turn`) now also emits one analytics **event** via a single listener registered in
  `createGatewayServer`. The event carries **only metadata** — surface, direction, decision, PII
  **type names**, latency — **never a raw matched value**. So the dashboard shows real data for
  every already-wired surface with no other changes.
- **Storage:** `src/admin-store.ts` (`node:sqlite`) — tables `events`, `surface_config`,
  `admin_users`, `audit_log`. SQL is ANSI-plain so a later move to Postgres is a driver swap.

---

## The internal API (for enforcement points)

Two loopback endpoints, meant to be called by the enforcement points that live **outside** the
gateway process (the MV3 extension service worker, the Cursor hook scripts). The in-process proxy
already emits events via the listener, so it does not need these.

### `POST /internal/events` — report a decision (fire-and-forget)

```jsonc
// body (all fields but surface+decision optional):
{
  "surface": "chatgpt",              // one of the known surface keys (see below)
  "direction": "outgoing",           // "outgoing" (request) | "incoming" (response)
  "decision": "redacted",            // "allowed" | "blocked" | "redacted"
  "pii_types": ["EMAIL", "SSN"],     // TYPE NAMES ONLY — never a raw value
  "latency_ms": 12
}
```
- Always returns `202` fast; a failure/timeout here must **never** block or delay the user's real
  request. `pii_types` is sanitised server-side to token-shaped names, so a raw value can never be
  persisted even by mistake.

### `GET /internal/config/:surface` — read current enforcement config

```jsonc
{
  "surface": "chatgpt", "enabled": true, "mode": "redact",
  "pii_type_toggles": {}, "fail_mode": "closed",
  "globalPiiTypes": { "EMAIL": true, "SSN": true, ... },
  "version": 3
}
```
- Poll this (or cache it for a few seconds); near-real-time is enough. `version` bumps on any change
  so a caller can cheaply detect an update.

### Surface keys

`claude-code`, `gemini`, `chatgpt`, `grok`, `deepseek`, `openai` (redact/block/off), and `cursor`
(block/allow only).

---

## Wiring status

- **Analytics data** — already flows for **every** surface: the proxy, `/redact` audits, and each
  extension `/log-turn` all push a `LogEntry`, and the in-process listener turns each into an event.
  Nothing extra needed for the dashboard to show real data.
- **Extension config enforcement** — **WIRED** (this pass): the MV3 service worker serves
  `GET /internal/config/:surface` to `content-main.js`, which enforces block/off/redact per §Enforcement.
- **`POST /internal/events`** — available for any future out-of-process caller that does *not* already
  log via `/log-turn` (e.g. a bespoke Cursor-hook event). Keep such calls **fire-and-forget** — the
  enforcement decision must never wait on analytics.
- **Cursor enforcement** — the Cursor hook path still enforces block/allow itself; reading
  `/internal/config` from the hooks to honor the admin mode is a small future add.

---

## Security notes

- **No raw PII** is stored anywhere in the admin DB — only type names, surface, decision, timing.
  A test (`tests/phase-admin.test.ts`) asserts a raw value sneaked into `pii_types` is dropped.
- Passwords are scrypt-hashed (salted). Sessions are HS256 JWTs (8h). Login is rate-limited
  5/min/IP. No signup route — admins are created only via `admin:seed`.
- `/admin/api/*` requires a valid JWT; `/internal/*` is loopback-only (same trust boundary as the
  existing hook endpoints). The dashboard, DB, and gateway all bind `127.0.0.1`.
- The dashboard stays usable if a surface is silent — it shows "no data / last seen X ago" rather
  than erroring.

## Tests

`tests/phase-admin.test.ts` (9, part of `npm test`): login + JWT gating + rate-limit + tampered/
expired token; `/internal/events` → analytics, malformed body is harmless, no-raw-PII; surface mode
PUT → `/internal/config` + audit row, Cursor→redact rejected, audit append-only.
