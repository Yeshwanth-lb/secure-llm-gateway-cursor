# DEVELOPERS.md — Human Setup, Run & Test Guide

Onboarding for people building the **Secure LLM Gateway Proxy**. For the rules that govern
*how* we work (TDD, the phase gate, coding invariants) see **[CLAUDE.md](CLAUDE.md)** — it is
the operating manual and holds the live status ledger. **[AGENTS.md](AGENTS.md)** is the
short version for AI coding tools.

**Team:** Mohit Sahoo (redaction + streaming), Yeshwanth (routing + proxy + log + MCP).

---

## 1. Prerequisites

- **Node ≥ 22** (developed on v24). Check: `node --version`.
- **Zero runtime dependencies** — gateway + tests use Node built-ins only.
- **Optional dev deps:** `npm install` once for TypeScript/types if you run `npm run build`
  (`typescript`, `@types/node` in `package.json`). Not required to run or test the gateway.

---

## 2. Run the gateway

**Always run installer/lifecycle commands from the repo root** (or use absolute paths):

```bash
cd /path/to/MCP-PROXY
node scripts/gateway-service.mjs start          # or: npm run dev
```

Manual run (no service):

```bash
node --experimental-strip-types secure-llm-gateway.ts
# or: npm run dev / npm start
# MCP stdio: node --experimental-strip-types secure-llm-gateway.ts --stdio
```

Listens on `http://127.0.0.1:8000` (`GATEWAY_HOST` / `GATEWAY_PORT`).

After **code changes** (new redaction rules, bug fixes):

```bash
node scripts/gateway-service.mjs restart --force
```

`start` alone reuses a healthy process and will **not** reload code.

### Point clients at it
```bash
# Anthropic SDK:  ANTHROPIC_BASE_URL=http://127.0.0.1:8000
# OpenAI SDK:     OPENAI_BASE_URL=http://127.0.0.1:8000/v1
# Gemini:         http://127.0.0.1:8000/gemini/…
# MCP:            http://127.0.0.1:8000/mcp
```

### Useful env vars
| Var | Purpose |
|---|---|
| `GATEWAY_HOST` / `GATEWAY_PORT` | Bind address (default `127.0.0.1:8000`). |
| `GATEWAY_ADMIN_TOKEN` | When set, `/api/*` POST mutations require `x-gateway-token` from non-browser callers. |
| `GATEWAY_INSTALL_ID` / `GATEWAY_STATE_DIR` | Set by `gateway-service`; used for installId health checks. |
| `ANTHROPIC_UPSTREAM` / `GEMINI_UPSTREAM` / `OPENAI_COMPAT_UPSTREAM` | Override upstream bases. |
| `STREAM_HOLDBACK_CHARS` | SSE holdback window (default 96). |
| `SNAPSHOT_CHARS` | Log snapshot cap per request/response (default 256 KB; `0` = unlimited). |
| `CUSTOM_REGEX_RULES` / `CUSTOM_REGEX_RULES_FILE` | Extra redaction rules (JSON), merged ahead of defaults. |

### Default redaction rules (14)
`PRIVATE_KEY`, `JWT`, `CONN_STRING`, `API_KEY`, `BEARER_TOKEN`, `EMAIL`, `PHONE_US`,
`PHONE_IN`, `CREDIT_CARD`, `SSN`, `PAN_IN`, `AADHAAR`, `IPV4`, `IPV6`. Live list:
`GET http://127.0.0.1:8000/rules` or the Gateway Console at `/`.

**JWT note:** header must start with `eyJ`; payload and signature are base64url (optional
`=` padding). Short payloads like `e30` (`{}`) are matched.

### Admin endpoints
`GET /healthz` · `GET /logs` · `GET /rules` · `GET /api/state` · console at `/` or `/mcp`.

---

## 3. Testing — the heart of this project

We build **test-first**, and every phase is **gated by 3 end-to-end tests**. Read CLAUDE.md
§3 for the full contract; the mechanics are here.

### Layout
```
tests/
  helpers/fake-upstream.ts   # local fake provider, JSON + SSE
  helpers/gateway.ts         # ephemeral-port gateway boot helper
  helpers/net.ts             # freePort()
  phase-0.test.ts … phase-c.test.ts
  phase-d.test.ts            # traffic inspector
  phase-e.test.ts            # control-plane console + /api
  phase-f.test.ts            # proxy snapshot / sanitize regressions
  phase-g.test.ts            # clean view
  phase-h.test.ts            # model policy
  phase-i.test.ts            # cross-platform installer + hooks
  phase-a1.test.ts …         # (see filenames — full suite is cumulative)
```

### Commands
```bash
npm test                     # full suite (76 tests)
npm run dev                  # run gateway from source
node --experimental-strip-types --test tests/phase-a1.test.ts   # one file
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
| D–I | Inspector, console, clean view, model policy, cross-platform hooks — see CLAUDE.md §8. | — |

**Contracts** (frozen in Phase 0, in `src/contracts.ts` + re-exported from
`secure-llm-gateway.ts`): `Provider`, `RouteResult`, `RedactionRule`, `redactText`,
`redactJson`, `LogEntry`, `trafficLog`, `StreamRedactor`. Don't change a contract
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

---

## Cross-platform installer & client integration

One shared gateway on `127.0.0.1:8000` serves both Claude Code and Cursor (same
process, MCP endpoint, traffic log, Traffic Inspector). Installer is zero-dep Node.

```bash
# from the repo root (required — scripts are not on PATH)
cd /path/to/MCP-PROXY
node scripts/gateway-service.mjs install
node scripts/gateway-service.mjs status
node scripts/gateway-service.mjs doctor
node scripts/gateway-service.mjs configure-clients
node scripts/gateway-service.mjs stop|start|restart [--force]
node scripts/gateway-service.mjs uninstall
```

**Scripts:**
| File | Role |
|---|---|
| `gateway-service.mjs` | install / lifecycle / configure-clients / doctor |
| `claude-session-hook.mjs` | Claude SessionStart: `start` then fail-closed health |
| `health-check.mjs` | Fail-closed `/healthz` probe (used by hooks) |
| `cursor-gateway-hook.mjs` | Cursor fail-closed gate (5s health cache) |
| `ensure-gateway.sh` | Thin wrapper → `claude-session-hook.mjs` (legacy) |

- **Service adapters:** macOS `launchd` user agent, Linux `systemd --user`, Windows
  Scheduled Task. Repo + Node path auto-discovered; one canonical host/port/log.
- **Idempotent + fail-closed:** a healthy gateway with a matching `installId` is reused;
  a foreign listener on `:port` is recycled; `install`/`start` return non-zero if `/healthz`
  never comes up. Use `restart --force` after code changes.
- **`/healthz`** carries a stable `installId` (persisted in `~/.secure-llm-gateway/`)
  so `doctor` confirms the listener is *this* gateway.
- **Client config (no `.mdc`):** Repo `.claude/settings.json` and user `~/.claude/settings.json`
  get `ANTHROPIC_BASE_URL` + `SessionStart` → `claude-session-hook.mjs` (start, then
  fail-closed health). Cursor `~/.cursor/mcp.json` + `hooks.json` get the shared MCP server
  and fail-closed `sessionStart`/`beforeMCPExecution` hooks. Run `configure-clients` to
  sync user-level config; merge preserves existing hooks.
- **Control plane auth:** set `GATEWAY_ADMIN_TOKEN` to require `x-gateway-token` on
  `/api/*` POST mutations from non-browser local callers. Loopback browser Origin still
  works for the console when the token is set.

### Demo
1. `node scripts/gateway-service.mjs install`
2. `node scripts/gateway-service.mjs doctor`
3. **Restart Cursor** if you ran `configure-clients` (hooks/MCP load at launch).
4. From another repo, launch Claude Code and send a prompt with test PII.
5. In Cursor, call the gateway MCP tool `get_traffic_logs`.
6. Open `http://127.0.0.1:8000/` — both clients appear in one Traffic Inspector.
7. After pulling code changes: `node scripts/gateway-service.mjs restart --force`.
8. Stop the service → managed hooks fail closed (sessions refuse). Restart → recovers.

### MDM handoff
The demo writes user-level config. In production, MDM distributes the equivalent
**managed** service + client config with locked permissions, keeps provider
credentials in the service environment (never handed to clients), and blocks direct
provider egress. Bypass resistance is an MDM policy property — the repo alone cannot
make a user-controlled admin account non-bypassable.

---

## Remote deploy (Render / cloud)

Local mode (default) binds **127.0.0.1 only**. Cloud mode is opt-in via `GATEWAY_REMOTE=1`.

### 1. Deploy to Render

1. Push this repo to GitHub.
2. Create a **Web Service** on Render from the repo (Blueprint uses `render.yaml`).
3. In Render **Environment**, set **`GATEWAY_ADMIN_TOKEN`** (required). Blueprint can
   auto-generate it via `generateValue: true` in `render.yaml`.
4. Confirm logs show `listening on http://0.0.0.0:…` — **not** `127.0.0.1`. If you see
   `127.0.0.1`, redeploy after pulling the latest code (Render auto-sets `RENDER=true`
   which now triggers `0.0.0.0` bind).
5. Note the public URL, e.g. `https://secure-llm-gateway-xxxx.onrender.com`.

Required env on Render:

| Var | Value |
|---|---|
| `GATEWAY_REMOTE` | `1` |
| `GATEWAY_HOST` | `0.0.0.0` |
| `GATEWAY_ADMIN_TOKEN` | strong random secret |
| `PORT` | set automatically by Render |

### 2. Configure Cursor on your Mac

```bash
cd /path/to/MCP-PROXY
export GATEWAY_MCP_TOKEN="<same as Render GATEWAY_ADMIN_TOKEN>"
node scripts/gateway-service.mjs configure-cursor --remote-url https://YOUR-SERVICE.onrender.com
```

Restart Cursor. The hook health-checks the remote URL; MCP calls send
`x-gateway-token` via `${env:GATEWAY_MCP_TOKEN}`.

Add to `~/.zshrc` so the token survives restarts:

```bash
export GATEWAY_MCP_TOKEN="your-render-admin-token"
```

### 3. What works remotely

| Endpoint | Auth | Purpose |
|---|---|---|
| `/healthz` | Public | Health checks (hooks, Render) |
| `/mcp` | `x-gateway-token` or `Authorization: Bearer` | Cursor MCP (`get_traffic_logs`) |
| `/anthropic/*`, `/openai/*`, … | Provider API keys from client headers | LLM proxy (data plane) |
| `/logs`, `/api/*` | Admin token | Control plane |

**Note:** The LLM proxy on Render redacts traffic but **PII still transits the cloud**.
For strict local-only redaction, keep the gateway on loopback. Remote mode is for
trying MCP observability + shared team access, not maximum privacy.

### 4. Local vs remote quick reference

| | Local (default) | Remote (Render) |
|---|---|---|
| Bind | `127.0.0.1:8000` | `0.0.0.0:$PORT` |
| Cursor MCP URL | `http://127.0.0.1:8000/mcp` | `https://….onrender.com/mcp` |
| MCP auth | None | `GATEWAY_MCP_TOKEN` |
| Configure | `configure-clients` | `configure-cursor --remote-url …` |
