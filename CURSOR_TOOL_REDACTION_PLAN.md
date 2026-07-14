# Phase L — Cursor tool-data redaction via `preToolUse` / `postToolUse`

**Status:** Proposed (not built)
**Author:** Yeshwanth (with Claude Code)
**Depends on:** Phase K (block hooks), Phase A1/A2 (redaction engine), gateway `/detect`
**Design authority:** this file + CLAUDE.md §3 (TDD + phase gate). If in doubt, CLAUDE.md wins.

---

## 0. Why this phase exists (the mentor's point)

We proved Cursor **chat** cannot be redacted by a local gateway: Cursor calls the model from its **own cloud**, and a loopback base URL is unreachable ("Access to private networks is forbidden"). See `CURSOR_BLOCKER_REPORT.md`.

We *also* wrongly assumed all Cursor hooks are block-only. They are not. Verified against `cursor.com/docs/agent/hooks`:

- **`preToolUse`** returns `updated_input` → it can **rewrite a tool's input** before the tool runs (and can still allow/deny).
- **`postToolUse`** returns `updated_mcp_tool_output` (+ `additional_context`) → it can **rewrite an MCP tool's output** before that output is handed back to the model.

Rewrite capability = real **scrub-and-forward**, locally, with no public hosting. It doesn't touch the chat, but it protects the **tool data path**, which is where a lot of real PII actually moves in agent workflows (files, DB rows, API responses pulled by MCP tools).

**Phase L goal:** wire `preToolUse` + `postToolUse` to the gateway's redaction engine so PII in tool inputs and MCP tool outputs is **scrubbed in transit** on the local machine, before it is sent to Cursor's cloud.

---

## 1. What Phase L covers — and what it explicitly does not

### In scope (can scrub)
- **MCP tool input** — args the model wants to pass to an MCP tool (`preToolUse.updated_input`).
- **MCP tool output** — data an MCP tool returns before it goes back to the model (`postToolUse.updated_mcp_tool_output`).

### Out of scope (Cursor cannot scrub these — block or nothing)
- **User's typed chat prompt** — `beforeSubmitPrompt` is block-only (already Phase K).
- **Model's chat response** — `afterAgentResponse` is observe-only.
- **Shell command output** — `afterShellExecution` is observe-only; `beforeShellExecution` is allow/deny only. So shell output **cannot** be rewritten — we can only *block* a shell command whose *input* contains PII (permission hook), not scrub its output.
- **The chat request itself** — Cursor-cloud routed, unreachable (the Phase-J wall).

> Honesty rule for the ledger: Phase L upgrades Cursor from "block PII" to "**scrub MCP/tool-data PII + block the rest**." It does **not** make Cursor chat redaction work. Do not oversell it.

---

## 2. Data flows — which hook guards which hop

```
                         YOUR MACHINE                         │   CURSOR CLOUD        │  PROVIDER
                                                              │                       │
  you type prompt ──beforeSubmitPrompt(block only)──────────► sent to cloud ─────────► model
                                                              │                       │
  model asks to call an MCP tool ◄──────────────────────────── decides tool call ◄────┘
        │                                                     │
        ├─ preToolUse(SCRUB updated_input) ─► tool runs locally
        │                                        │
        │                                        ▼
        └─ postToolUse(SCRUB updated_mcp_tool_output) ─► result sent to cloud ─────────► model
                                                              │
  shell tool: beforeShellExecution(block only) ─► runs ─► afterShellExecution(observe only)
```

**The wins:**
- `postToolUse` sits **before** the tool result leaves for Cursor's cloud → scrubbing there means the raw PII in a tool result never reaches Cursor. This is the same guarantee Claude Code gets, for the MCP-tool hop.
- `preToolUse` scrubs PII the model tries to push into a tool call.

---

## 3. Verified hook capability table (source: cursor.com/docs/agent/hooks)

| Hook | Rewrite field | Block? | Phase L use |
|------|---------------|--------|-------------|
| `preToolUse` | `updated_input` | yes | **SCRUB tool input** (+ optional block) |
| `postToolUse` | `updated_mcp_tool_output`, `additional_context` | no | **SCRUB MCP tool output** |
| `beforeSubmitPrompt` | — | block only | Phase K (block prompt PII) |
| `beforeReadFile` / `beforeTabFileRead` | — | block only | Phase K (block file PII) |
| `beforeShellExecution` / `beforeMCPExecution` | — | block only | permission gate |
| `afterShellExecution` / `afterMCPExecution` / `afterFileEdit` / `afterAgentResponse` | — | observe only | not usable for scrub |

> ⚠️ **Verify before building:** the exact JSON field names for `preToolUse`/`postToolUse` **input** (what Cursor sends on stdin) and the precise **output** envelope (`updated_input` shape, whether it's the whole input object or a delta) are not yet confirmed from a live run — only from docs. Step 1 of the build is to capture a real payload (log stdin to stderr) and pin the contract. Do not hardcode field names from this doc without that check.

---

## 4. Architecture

Reuse everything from Phase K; add one endpoint and one hook script.

### 4.1 New gateway endpoint: `POST /redact`
`/detect` only returns match **counts** (`{ matched, piiDetected }`) — it deliberately does not return text. Phase L needs the **scrubbed text back**, so add a sibling:

- **Request:** `{ "text": "<raw>" }` (or `{ "value": <any JSON> }` for structured tool input).
- **Response:** `{ "redacted": "<scrubbed text>", "matched": { "EMAIL": 2, ... }, "piiDetected": true }`.
- Implementation: call existing `redactText(text, "inbound")` (returns `{ text, matched }`) and return `text` as `redacted`. For JSON tool input, use `redactJson`.
- **Same guards as `/detect`:** loopback-Origin gated, **never logs raw text**, uses the live rule set.
- Security: this endpoint returns redacted text (safe) but receives raw text — keep it loopback-only, never persist the input.

### 4.2 New hook script: `scripts/cursor-tool-redact-hook.mjs`
Mirrors `cursor-redact-hook.mjs`, but instead of allow/deny it returns the **rewritten payload**:

- Read stdin JSON (Cursor hook context).
- Branch on `hook_event_name`:
  - `preToolUse`: extract the tool input, send text through `POST /redact`, emit `{ "updated_input": <scrubbed input> }`.
  - `postToolUse`: extract the MCP tool output, scrub, emit `{ "updated_mcp_tool_output": <scrubbed output> }`.
- **Fail-closed policy (different from Phase K — think carefully):** these hooks *rewrite*, they don't block. If the gateway is unreachable we cannot scrub. Failing "open" (pass raw through) would leak. Options, in order of preference:
  1. `preToolUse`: on error, **deny the tool call** (it supports allow/deny) → fail-closed, no leak.
  2. `postToolUse`: it **cannot block**. On error, emit `additional_context` warning AND replace the output with a redaction-failure placeholder (`"[tool output withheld: PII gateway unreachable]"`) rather than passing raw. Never emit raw output on error.
- Diagnostics to **stderr**; the JSON decision to **stdout** (same discipline as Phase K).

### 4.3 Wiring: `~/.cursor/hooks.json` + `configure-clients`
Add `preToolUse` and `postToolUse` entries pointing at the new script. Update `scripts/gateway-service.mjs configure-cursor` to write them so new installs inherit it. Keep `failClosed: true`.

### 4.4 No change to the redaction engine
`redactText`/`redactJson` are untouched — Phase L is plumbing around the existing core. Zero new runtime deps (hard constraint holds).

---

## 5. Config

| Env / knob | Purpose | Default |
|---|---|---|
| (reuse) `GATEWAY_HOST`/`PORT` | hook → gateway URL | `127.0.0.1:8000` |
| new (optional) `CURSOR_TOOL_REDACT_FAILMODE` | `deny` \| `withhold` on gateway error | fail-closed variants above |

No secrets introduced. No non-loopback anything.

---

## 6. TDD phase gate — the 3 required e2e tests

Per CLAUDE.md §3.2, three tests through the real interfaces (spawn the hook as a subprocess with `spawn`, NOT `spawnSync` — Phase K learned this: `spawnSync` deadlocks the in-process gateway serving `/redact`). File: `tests/phase-l.test.ts`.

1. **Happy** — `postToolUse` with an MCP tool output containing an email → hook returns `{ updated_mcp_tool_output: ... }` with the email replaced by `[REDACTED_PII_EMAIL]`; assert the raw email is absent from stdout and `matched.EMAIL >= 1`.
2. **Failure** — gateway `/redact` unreachable (point hook at a dead port) → `preToolUse` returns a **deny** (no raw input passed through) and `postToolUse` returns the withhold placeholder, never the raw text. Asserts fail-closed: raw PII never appears in output.
3. **Edge** — PII split/awkward: tool output where PII sits at a JSON boundary or the input is structured (nested object) → `redactJson` path scrubs nested string fields; assert no raw PII survives and non-PII fields are untouched. Also: empty/no-PII output passes through unchanged (no spurious rewrite).

Plus: full cumulative suite stays green (currently 89/89 → target 92/92). Update the CLAUDE.md ledger row in the same change.

---

## 7. Security invariants (must all hold)

- [ ] `/redact` is loopback-Origin gated and **never logs raw input**.
- [ ] On any hook error, **no raw tool data is emitted** (deny or withhold).
- [ ] stdout carries only the JSON decision; all diagnostics on stderr.
- [ ] No new runtime dependency.
- [ ] Hook output field names verified against a real captured Cursor payload (Step 1), not assumed from this doc.

---

## 8. Honest limitations (put these in the ledger + report)

1. **Chat is still unprotected** (prompt block-only, response observe-only, base URL unreachable). Phase L does not change this.
2. **Shell output cannot be scrubbed** — only MCP tool output. A shell command that prints PII will still send that to Cursor's cloud; the only control is blocking the command via `beforeShellExecution`.
3. **`postToolUse` may be MCP-only.** If Cursor's `updated_*` rewrite applies only to MCP tools (not built-in tools), non-MCP tool outputs remain unscrubbable. Confirm in Step 1.
4. **Latency** — every tool call now round-trips to the local gateway. Small (loopback), but non-zero; note it.

---

## 9. Build order (checklist)

1. **Capture a real payload.** Temporarily log `preToolUse`/`postToolUse` stdin to stderr; run a Cursor MCP tool; pin the exact input/output JSON contract. **Gate everything else on this.**
2. Add `POST /redact` to `src/server.ts` (+ reuse `redactText`/`redactJson`). Write its unit test first (red→green).
3. Write `tests/phase-l.test.ts` (the 3 e2e tests) — they fail (red).
4. Implement `scripts/cursor-tool-redact-hook.mjs` until the 3 tests pass (green).
5. Wire `hooks.json` + `configure-cursor`; add the stdio→async-spawn note.
6. Run full suite (`npm test`) — all green.
7. Update CLAUDE.md ledger: add Phase L row, bump counts, update "Last updated"/"Current phase".
8. Update `CURSOR_BLOCKER_REPORT.md` §6 (Option C) to note tool-data scrub is now implemented.

---

## 10. One-paragraph summary

Cursor chat can't be redacted (cloud-routed, loopback unreachable), but Cursor's `preToolUse`/`postToolUse` hooks **can rewrite** tool inputs and MCP tool outputs. Phase L routes those through a new loopback `/redact` endpoint backed by the existing redaction engine, so PII in tool data is scrubbed on the local machine before reaching Cursor's cloud — fail-closed, zero new deps. It's a real upgrade for the tool-data path, not a fix for chat.
