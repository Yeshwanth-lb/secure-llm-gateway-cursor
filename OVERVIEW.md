# Project Overview — Local PII-Redaction Gateway + Browser Extension

*A plain-language summary of what this project is and everything built so far. Written to be
read top-to-bottom when explaining the project to someone. For the exact engineering status
see `CLAUDE.md` §8; for the full dated history see `LEDGER_HISTORY.md`.*

---

## 1. What it is, in one line

A **local privacy tool** that automatically strips personal/sensitive information (PII) out of
whatever you type into AI chatbots and AI features **before it leaves your computer** — so
secrets never reach the AI provider — while you keep using the tools normally.

It has **zero external dependencies** and runs **entirely on your own machine** (`127.0.0.1`).
Nothing is sent to any third-party service by the tool itself.

---

## 2. The problem it solves

People paste real data into AI tools all day — customer emails, phone numbers, SSNs, credit
cards, API keys, internal addresses, whole documents. That data leaves the company and lands
on someone else's servers. Most "DLP" products are heavy, cloud-based, and see all your traffic.

This project does the opposite: a **tiny, local, zero-dependency** gateway that redacts PII in
place. A typed email like `jane@corp.com` becomes `[REDACTED_PII_EMAIL]` on the wire; the AI
answers about the placeholder, and the real value never left the machine.

---

## 3. How it works — two pieces

### A. The gateway (the engine)
A small local server (`127.0.0.1:8001`) written in TypeScript using only built-in Node modules
(no frameworks, no installed packages — "zero supply-chain surface" is a deliberate feature).
It does three things:
1. **Redacts PII both ways** — scrubs a request before it goes out, and scrubs the AI's reply,
   including PII that's split across streaming chunks.
2. **Logs traffic** in a small in-memory buffer — but only *after* redaction, so it never
   stores raw PII. A web console (the "Traffic Inspector") shows each turn: who, what model,
   the cleaned prompt, the cleaned reply, and which PII rules fired.
3. **Exposes an inspection tool** (an embedded MCP server) so an agent/reviewer can query what
   was caught.

It knows **14 kinds of PII** out of the box: email, US & Indian phone numbers, SSN, credit card
(with a real Luhn check to avoid false positives), Indian PAN & Aadhaar, IPv4/IPv6, JWTs, API
keys, bearer tokens, DB connection strings, and private keys.

### B. The browser extension (the reach)
Websites send your prompt from *their* servers, so there's no local request to intercept — the
only place to catch it is **in the browser, at the moment you hit send**. A browser extension:
1. Intercepts your submit,
2. Sends the text to the local gateway to be redacted,
3. Writes the redacted text back into the chat box,
4. Re-sends it — so the AI receives only the cleaned version.

There is also a **fail-closed "tripwire"**: an independent safety net that watches the browser's
outgoing requests and **aborts any that still contain raw PII**. If the page ever changes in a
way that breaks step 3, the tripwire blocks the send rather than leaking — *"block, never leak."*

The extension also **guards file uploads**: attaching a file is caught, the file is scanned and
redacted (or, for formats we can't read like PDFs/images, **blocked** rather than uploaded
unscanned). Word/Excel/PowerPoint files are actually **cleaned and sent** (they're ZIP+XML, which
we can read and rewrite with browser built-ins).

---

## 4. What's covered today

**AI chat websites — redaction working live (Chrome unless noted):**

| Surface | Status |
|---|---|
| **gemini.google.com** | ✅ text + file uploads |
| **Google Workspace "Ask Gemini" panels** — Gmail, Docs, Sheets, Slides, Drive, Chat | ✅ text (Drive slightly flaky) |
| **chatgpt.com** | ✅ text + uploads (also verified on **Firefox**) |
| **grok.com** (xAI) | ✅ text + uploads |
| **chat.deepseek.com** | ✅ text + uploads |

**Developer tools:**
- **Claude Code** — routed through the gateway (full bidirectional redaction).
- **Cursor** — PII prompts are **blocked** before send, tool inputs/outputs are scrubbed, and
  every chat turn is logged. Two paths Cursor won't let any extension block (messages queued
  while the agent is busy, and auto-attached open files) are **audited and flagged** instead.

**The tool itself:** the gateway, the redaction engine, the web console (rules, allowlist, model
policy, traffic inspector), and cross-browser builds (Chrome done; Firefox done; Safari packaged
but unverified on this machine).

Everything is backed by an automated test suite — **188 tests, all green.**

---

## 5. The security guarantees (how to describe the "why trust it")

- **Redact at the source, not on the wire.** The prompt is cleaned before the page builds its
  request, so it works even when a site encrypts its traffic.
- **Fail closed.** If redaction can't complete, or the chat box can't be found, or the gateway is
  down — the send is **blocked**, not leaked. The tripwire is a second, independent net.
- **Never stores raw PII.** Logs and snapshots hold only already-redacted text. A test enforces this.
- **Local only.** Binds to `127.0.0.1`; never listens on the network. Auth headers (API keys) are
  never touched — only message bodies are redacted.
- **Zero dependencies.** No third-party packages to trust or get compromised.

---

## 6. Honest limitations (say these too — they build credibility)

- **DeepSeek encrypts its chat request**, so the tripwire safety net can't inspect that send. The
  primary redaction still works (we clean the box before DeepSeek encrypts it); it's just the
  backstop that's blind there. Its file uploads are plaintext, so those are fully covered.
- **Google keeps changing the Workspace chat box.** A recent Google update briefly broke sending
  from the Workspace panels; we fixed it, but it's a moving target and may need occasional re-tuning.
- **Firefox Workspace panels**: PII messages can't be sent there yet (they're blocked, not leaked).
  Chrome is fine.
- **Safari** is packaged but couldn't be built/verified on the current machine (needs full Xcode).
- **Cursor's queued/auto-attached paths** can't be blocked by any extension — they're audited &
  flagged, and the real fix has to come from Cursor.

---

## 7. Where things live (for a technical listener)

- `secure-llm-gateway.ts` + `src/` — the gateway engine (redaction, routing, proxy, console, MCP).
- `extension/` — the browser extension (Chrome package; `extension/build/{firefox,safari}` generated).
- `extension/src/site-adapter.js` — the per-website settings (which box to type in, which request
  to watch), one entry per surface, keyed by hostname.
- `tests/` — the 188-test suite (`npm test`).
- `CLAUDE.md` — the operating manual + current status ledger. `LEDGER_HISTORY.md` — full history.

---

## 8. The one-paragraph version (for a quick verbal explanation)

> "It's a local privacy filter for AI tools. Everything you type into ChatGPT, Gemini, Grok,
> DeepSeek, Cursor, or Claude Code gets scanned on your own machine first — emails, SSNs, cards,
> API keys, and 10 other kinds of sensitive data are replaced with placeholders before the text
> ever leaves the browser. If anything ever fails, it blocks the send instead of leaking. It has
> no external dependencies, runs entirely on `127.0.0.1`, and shows you a live log of exactly
> what was caught. It covers five AI websites plus the Google Workspace AI panels and two
> developer tools, all backed by a green test suite."
