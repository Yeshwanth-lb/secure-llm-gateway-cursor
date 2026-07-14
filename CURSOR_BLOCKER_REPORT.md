# Cursor Chat Redaction — Blocker Report

**Date:** 2026-07-13
**Author:** Yeshwanth (with Claude Code)
**Audience:** Eng lead
**Status:** Blocked by Cursor architecture — needs a direction call

---

## TL;DR

We built a local gateway that redacts PII out of LLM traffic before it leaves the machine. It works end-to-end for **Claude Code**. We tried to extend the same protection to **Cursor's chat/agent**, and hit a hard wall: **Cursor does not send chat requests from your machine — it sends them from Cursor's own cloud servers.** Our gateway only listens on `127.0.0.1` (loopback, by design), and Cursor's servers explicitly refuse to call private/loopback addresses. So Cursor chat can never reach our gateway without making the gateway public — which breaks the whole security premise.

Net: **bidirectional redaction of Cursor chat is not achievable with a local-only gateway.** We can still *block* PII in Cursor at the source (already working), just not scrub-and-forward it.

---

## 1. What we're building (context)

A zero-dependency **local proxy** that sits between an LLM client and the model provider (Anthropic/OpenAI/Gemini). It:

1. **Redacts PII** from the request *before any byte leaves the machine*, and from the model's response.
2. **Logs** post-redaction traffic locally so we can audit what would have leaked.
3. Exposes an **MCP tool** (`get_traffic_logs`) so agents/reviewers can inspect it.

**Core security constraint (deliberate):** the gateway binds to `127.0.0.1` **only**. It literally refuses to start on any non-loopback address. The point is that traffic is inspected and scrubbed *on the user's own machine* — nothing transits a third party in raw form.

## 2. What already works — Claude Code

Claude Code lets you set `ANTHROPIC_BASE_URL`. We point it at `http://127.0.0.1:8000`. Claude Code then makes its API calls **from the local machine** to our local gateway, which scrubs and forwards to Anthropic.

**This is verified working** — real email addresses get redacted out of live Claude Code prompts. The reason it works is the key detail for everything below: **Claude Code calls the provider locally.**

## 3. What we tried for Cursor

Cursor exposes one relevant setting: **"Override OpenAI Base URL."** The plan (called "Phase J" internally) was:

- Point Cursor's base URL at `http://127.0.0.1:8000/openai`.
- Our gateway detects Cursor's model, translates the OpenAI-style request into an Anthropic request, scrubs PII, forwards to Claude, and translates the response back.

The translation layer itself is **built and correct** — when we call the gateway directly with `curl`, it translates and redacts perfectly (both streaming and non-streaming). The problem is not our code.

## 4. The investigation — what actually happened

We tried to use it in Cursor and got "Model name is not valid." We then instrumented the gateway's access log and watched it live while driving Cursor. Findings, in order:

| Step | Action | Result | What it told us |
|------|--------|--------|-----------------|
| 1 | Selected our custom model `claude-via-gateway`, sent a message | `"Model name is not valid"` — **gateway received nothing** | Cursor rejected it *before any network call*. Its logs show a client-side `classify` step that maps a model name to a provider; an unknown custom name matches nothing and is dropped. |
| 2 | Fixed a genuine bug we found (`/v1/models` returned 404 at one path) | Fixed, tests green | Real fix, but irrelevant to the wall — Cursor still wasn't calling us. |
| 3 | Switched Cursor from Agent mode to Ask mode, retried | Same error, gateway still received nothing | The mode is not the issue. |
| 4 | Added `gpt-4o` (a name Cursor **recognizes**) and selected it | **New** error: `"Provider returned error: Access to private networks is forbidden"` — gateway **still** received nothing | This is the decisive clue (see below). |

Throughout all four steps, our gateway's access log recorded **zero** requests from Cursor. The only Cursor traffic we ever saw was the local "block-if-PII" hook and MCP calls — never chat.

## 5. Root cause — the architectural wall

Reading Cursor's own error messages together explains everything:

- **`claude-via-gateway` → "model not valid":** Cursor validates the model name *on the client, before calling anything*. Custom/invented names are rejected outright.
- **`gpt-4o` → "Access to private networks is forbidden":** the recognized name passed validation, so Cursor *attempted* the request — and the request came **from Cursor's cloud servers**, which tried to dial `http://127.0.0.1:8000`. On their servers, `127.0.0.1` is *their own* loopback, and they explicitly forbid calling private-network addresses.

**Conclusion: Cursor performs provider API calls server-side (from Cursor's backend), not from the user's machine.** A "base URL" you configure is used *by Cursor's servers*, so it must be a **publicly reachable** address. A loopback/private address is unreachable by definition.

This is also confirmed by Cursor's own UI: the Anthropic-key panel states the key is *"used for all models beginning with claude-"* — i.e. Cursor calls Anthropic directly from its cloud for those models; the base URL never enters the picture.

**Why Claude Code works and Cursor doesn't:** Claude Code calls the provider **from your machine** (can reach `127.0.0.1`). Cursor calls it **from Cursor's cloud** (cannot, and won't, reach `127.0.0.1`). Our loopback-only design is fundamentally incompatible with a client that routes through its own cloud.

## 5b. "What about other models — Gemini, Grok, etc.?"

A fair question, since the translation work focused on OpenAI and Claude. Three separate facts:

1. **Redaction is provider-agnostic.** The scrubber works on the request/response *body*, not the provider. It doesn't matter whether the traffic is Anthropic, Gemini, or Grok — it finds PII patterns and replaces them. The gateway's router already supports three upstream families: **Anthropic, Gemini, and OpenAI-compatible** (Grok is OpenAI-compatible). If traffic reaches the gateway, it gets scrubbed regardless of model.

2. **Only the format-translation shim is model-specific.** We built an OpenAI↔Anthropic translator *only* because Cursor speaks OpenAI format but we wanted to reach Claude. A Cursor→Gemini path would need its own translator. That's narrow, per-provider work — but moot, because of point 3.

3. **The Cursor blocker applies to EVERY model, not just OpenAI/Claude.** This is the important part. In Cursor, *all* models — Cursor Grok, Composer, GPT-5.6, Sonnet, Gemini, Kimi, everything — are called **from Cursor's cloud servers**. Every one. So the "can't reach `127.0.0.1`" wall hits all of them equally. Picking Gemini or Grok instead of Claude changes nothing: Cursor's cloud still makes the call, and still never touches a local gateway.

**So this is not a "we only covered OpenAI/Claude" gap.** For Cursor it's a total wall across all providers. For clients that call locally (Claude Code, SDKs), the gateway already handles Anthropic + Gemini + OpenAI-compatible; only extra *format translators* would be per-provider work, and only when a client forces a format mismatch the way Cursor did.

| Client | Other models (Gemini/Grok/…) | Why |
|--------|------------------------------|-----|
| Claude Code | N/A — only talks to Anthropic | Calls locally; its Anthropic traffic *is* redacted |
| Local SDKs / LangChain | Redactable (Anthropic + Gemini + OpenAI-compatible all routed) | They call locally; gateway routes by provider |
| **Cursor** | **Not redactable — any model** | All models called from Cursor's cloud; loopback unreachable |

## 6. Options and trade-offs

### Option A — Host the gateway publicly (tunnel / cloud)
Expose the gateway at a public `https://` URL (ngrok, Cloudflare Tunnel, or a hosted deploy) so Cursor's cloud can reach it.

- ✅ Cursor chat would finally flow through the gateway; real redaction becomes possible.
- ❌ **Breaks our core security model.** The gateway is loopback-only *on purpose*; the code actively refuses non-loopback binds. Going public reintroduces exactly the remote surface this project deliberately removed.
- ❌ **Partially self-defeating.** The promise is "scrub before anything leaves the machine." A public gateway means every byte first travels to a public endpoint, and Cursor's cloud still sees the (now-redacted) traffic. It also means our Anthropic API key lives behind a public box.
- **Assessment:** technically works, but abandons the security guarantee that justifies the project. Not recommended without an explicit decision to change the threat model.

### Option B — Local network interception (proxy / MITM)
Force Cursor's outbound traffic through the gateway at the OS/network level (system proxy, hosts file + TLS interception).

- ❌ **Doesn't work here.** The chat request originates from Cursor's *cloud*, not your machine — there is no local outbound chat request to intercept. Only Cursor's own telemetry/auth is local. Dead end for the same root-cause reason as Option A.

### Option C — Accept the limit; protect Cursor with what runs locally (recommended)
Keep the loopback design. Give Cursor the protection that *doesn't* require routing chat through the gateway:

- **Block-if-PII hooks (already built, "Phase K"):** Cursor's `beforeSubmitPrompt` and `beforeReadFile` hooks run **on the local machine**. They call our local `/detect` endpoint and **block** the action when PII is present. This works today. Limitation: Cursor hooks can only allow/deny, not rewrite — so we *block* PII rather than scrub-and-forward it.
- **MCP `get_traffic_logs` inspector:** loopback, works.
- Keep the translation shim for Claude Code and any client that calls providers locally (SDKs, LangChain, etc.), where it is valid and tested.
- Document Phase J as "blocked by Cursor architecture" so no one re-investigates the symptom.

### Option D — Different client
Any client that calls the LLM locally (Claude Code today) is fully covered. This is a Cursor-specific limitation, not a gateway defect.

## 7. Recommendation

Go with **Option C**: keep the loopback security guarantee, rely on the block-at-source hooks for Cursor, and reserve full bidirectional redaction for locally-calling clients (Claude Code). Revisit a public deployment only if leadership explicitly decides the redaction-as-a-service (public gateway) threat model is acceptable — that's a product/security decision, not a bug fix.

## 8. One-line summary for the ticket

> Cursor routes chat through its own cloud and refuses private-network base URLs, so a loopback-only gateway can never intercept Cursor chat. Full redaction of Cursor chat requires a public gateway (breaks the security model). Recommendation: keep loopback, use local block-if-PII hooks for Cursor, keep full redaction for Claude Code.
