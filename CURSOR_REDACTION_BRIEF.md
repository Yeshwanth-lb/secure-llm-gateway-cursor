# Redacting Cursor traffic — what works, what's blocked, what's next

> **Engineering brief · PII Redaction Gateway**
> A local gateway scrubs PII from AI traffic before it leaves the machine. It works fully for Claude Code. Cursor hit an architectural wall — here's why, and what's still possible.

## Status at a glance

| Surface | State | Note |
|---|---|---|
| **Claude Code** | 🟢 Full redaction | All model traffic scrubbed both ways, verified live. |
| **Cursor — chat** | 🔴 Not possible | Cloud-routed; a local gateway is unreachable by design. |
| **Cursor — tool data** | 🟡 Partial (planned) | Block prompts today; scrub MCP tool data via Phase L. |

**Bottom line:** Our redaction engine is correct — proven by driving it directly. The Cursor limitation is **Cursor's architecture, not a bug in our code.** Full chat redaction for Cursor is not achievable with a local gateway, and hosting the gateway publicly wouldn't actually protect the data. Claude Code gets full protection; Cursor gets partial, local protection.

---

## What works — Claude Code

Claude Code makes its model calls **from your machine**, so we point it at the local gateway. Traffic is scrubbed on the way out and on the way back — and you keep working; nothing is blocked.

```
your machine  ──raw──►  LOCAL gateway (scrub)  ──clean──►  Anthropic
```

Verified end-to-end: a real email address in a live prompt was replaced with `[REDACTED_PII_EMAIL]` before it ever left the machine.

---

## The wall — Cursor chat

Cursor does **not** call the model from your machine. It sends the chat to **its own cloud servers**, which then call the provider. So a base URL pointed at our local gateway is dialed *by Cursor's cloud* — where `127.0.0.1` is their own loopback, and private-network targets are forbidden.

```
your machine  ──RAW──►  Cursor cloud (sees raw PII)  ──✗──►  provider
                                 ▲
                     gateway would sit here — downstream of the leak
```

We confirmed this live. Two errors, same wall:

- `claude-via-gateway` → **"Model name is not valid"** (rejected before any network call)
- `gpt-4o` → **"Provider returned error: Access to private networks is forbidden"**

This is true for **every** model in Cursor — GPT, Claude, Gemini, Grok — because all of them route through Cursor's cloud. It is not an "we only built OpenAI/Claude" gap.

---

## Can we force it? — public hosting

**Considered and rejected.** A public gateway *would* let Cursor connect — but it doesn't protect the data. The raw PII reaches **Cursor's cloud first**, before our gateway ever sees it. A gateway can only protect a hop it sits *in front of*, and there's no way to sit in front of the your-machine → Cursor-cloud hop. It also breaks the "stays local" security model and exposes our provider key.

---

## What we can do for Cursor — locally

Cursor's hooks run on your machine and give us two levers. Both stop PII **before** it leaves for Cursor's cloud.

- **Block — working today (Phase K).** If a prompt or a file the agent reads contains PII, we block it before submission. Safe, but blunt — it interrupts the work.
- **Scrub tool data — planned (Phase L).** Cursor's `preToolUse` / `postToolUse` hooks can *rewrite* content — so we can scrub PII out of MCP tool inputs and outputs in transit, without blocking. Tool outputs (file contents, DB rows) often carry the most PII.

**The honest limit:** these hooks only fire **around tool calls**, and only when a tool is actually used. They cannot touch the chat itself and cannot reroute it. There is **no way** to put the gateway in front of Cursor's chat — that path lives entirely in Cursor's cloud. Cursor coverage is partial and opportunistic; Claude Code coverage is complete.

---

## Coverage at a glance

| Path | Claude Code | Cursor |
|---|---|---|
| Prompt to the model | 🟢 Scrubbed | 🔴 Block only |
| Model response | 🟢 Scrubbed | 🔴 Untouchable |
| The chat request itself | 🟢 Through gateway | 🔴 Cloud — unreachable |
| MCP tool input / output | 🟢 Scrubbed | 🟡 Scrub via Phase L |
| Shell command output | 🟢 Scrubbed | 🔴 Observe only |

---

## Recommendation

- Keep the gateway **local**. Full redaction for Claude Code and any tool that calls models locally (SDKs, LangChain).
- For Cursor: keep block-if-PII (done), build tool-data scrub (Phase L — plan written).
- Treat "redact Cursor chat" as a **closed question** — not achievable without going public, and going public doesn't protect the data anyway.

---

*Full detail in the repo: `CURSOR_BLOCKER_REPORT.md` (the wall) · `CURSOR_TOOL_REDACTION_PLAN.md` (Phase L).*
