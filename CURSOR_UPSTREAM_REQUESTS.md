# Cursor upstream feature requests

Two prompt paths in Cursor deliver user content to the model **without invoking any hook
that can see or gate it**. We verified both live (Cursor 2.1.207 / hook API as of
2026-07). They are the only remaining PII-leak paths in our gateway's Cursor coverage —
everything else is blocked on the composer-send path or scrubbed on the tool path. Neither
can be closed from a hook; both need a Cursor-side change.

Full internal analysis: `CURSOR_INTEGRATION_PLAN.md` §7.3 (queue) and §7.1 (attachments).

---

## Request 1 — invoke `beforeSubmitPrompt` on the queue-drain path

**What happens today.** A message typed into the composer **while the agent is busy** is
queued, then delivered to the model when the agent frees up — with **no `beforeSubmitPrompt`
invocation at all**. Not an allow, not a deny: the gate is never asked. A message sent from
the composer while the agent is *idle* fires the hook correctly.

**Evidence (our invocation log, one line per real hook call).**

```
11:42:37  beforeSubmitPrompt  clean  ALLOW    <- "run the full test suite"
                                              <- queued: "my email is <addr>"  (NO ENTRY)
                                              <- queued: "did it work"         (NO ENTRY)
11:46:50  beforeSubmitPrompt  clean  ALLOW    <- next composer send
```

The invocation count did not move while two queued messages were delivered (one carrying a
real address). Cursor's UI showed "2 Queued" at that moment.

**Ask.** Invoke `beforeSubmitPrompt` for **every** message delivered to the model, including
messages drained from the queue, with the same allow/deny contract as an idle send. A
denied queued message should be dropped exactly as a denied composer send is.

**Why a hook can't work around it.** No other hook carries prompt text on the drain path:
`sessionStart`/`beforeMCPExecution` don't see prompts, `preToolUse`/`postToolUse` are tool
payloads, and `stop` fires after the model has already answered. The queued message is also
absent from the transcript while it sits in the queue (the transcript is written on
delivery), so an out-of-band scan can't see it either.

---

## Request 2 — surface auto-attached file content to `beforeSubmitPrompt`

**What happens today.** A file the user has **open or selected** (no `@`-mention) is
auto-inlined into the request as an `<attached_files>` block. That block is **not** in the
`beforeSubmitPrompt` payload — the hook fires and receives only the typed prompt text plus
an `attachments` array holding **only `type:"rule"` path refs** (`CLAUDE.md`, `AGENTS.md`).
The attached file's content appears nowhere in the hook payload, yet the model receives it.

**Evidence (per-field capture of one real `beforeSubmitPrompt` payload).** With a file
carrying a real email/SSN/card open in the editor and a 32-char typed prompt:

- `ctx.prompt` = the 32 typed chars only
- `ctx.attachments` = `[ {type:"rule", ...CLAUDE.md}, {type:"rule", ...AGENTS.md} ]`
- the selected file's content: **absent from every field**
- the transcript's `<attached_files>` block (written on delivery): **carried the full file**

So the hook fired and **allowed** — correctly, given what it could see — while the file's
raw PII rode to the model. The `@`-mention path (which we *do* cover, by resolving the
`@`-token to a file and scanning it) can't help here: there is no `@`-token to resolve.

**Ask.** Include auto-attached open/selected file content (or at least resolvable file
paths + line ranges) in the `beforeSubmitPrompt` payload, so the hook can scan and deny it
the same way it scans an `@`-mentioned or agent-read file. Alternatively, a documented
setting to disable auto-inclusion of open/selected files would let security-sensitive users
opt out.

---

## What we ship in the meantime

Prevention being impossible from a hook, both paths are **audited, not blocked**:

- `cursor-redact-hook.mjs` records a SHA-256 hash of every prompt it approves (hashes only,
  no text on disk).
- `cursor-turn-log-hook.mjs` flags any delivered message with no matching approval hash, and
  extracts `<attached_files>` blocks to count their PII, marking the traffic-log row
  `unchecked`.
- **`unchecked` + PII detected = a confirmed leak** in the Traffic Inspector (red pill) plus
  a loud stderr line. No raw PII is ever stored — counts and tokenised text only.

This makes both bypasses visible after the fact. Only a Cursor-side change makes them
preventable.

---

## How to file these

Cursor has **no public GitHub issue tracker** (`cursor/cursor` has issues disabled). The
channels are:

- **Community forum → Feature Requests:** <https://forum.cursor.com> (Discourse, needs a
  web login). Best fit — these are enhancement asks. Paste-ready post below.
- **In-app:** Help → Report Issue, or `Cmd+Shift+P` → "Report AI Action" (that path is for
  bugs tied to a specific Request ID; not needed for a feature request).
- **Bug Reports category** (<https://forum.cursor.com/c/support/bug-report/6>) is an
  alternative framing — the queue path is arguably a security bug, not just a request.

Posting is outward-facing and goes out under your forum identity, so it is left for a human
to submit. Sources: [forum](https://forum.cursor.com/), [Bug Reports
category](https://forum.cursor.com/c/support/bug-report/6), [reporting-bugs
docs](https://cursor.com/help/troubleshooting/reporting-bugs).

### Paste-ready forum post (Feature Requests)

> **Title:** Security hooks can't see two prompt paths — queued sends and auto-attached open/selected files
>
> **Body:**
>
> We build a local PII-redaction gateway that uses `beforeSubmitPrompt` / `beforeReadFile`
> hooks to block prompts containing sensitive data before they reach the model. Two paths
> deliver user content to the model with **no hook invocation that can see or gate it**, so
> we can only audit them after the fact, never prevent the leak. Both would be closed by a
> hook-payload change.
>
> **1. Queued messages skip `beforeSubmitPrompt` entirely.** A message typed while the agent
> is busy is queued and later delivered to the model with no `beforeSubmitPrompt` call at all
> — not an allow, not a deny. An idle composer send fires the hook correctly; the queue-drain
> path does not. *Request:* invoke `beforeSubmitPrompt` for every message delivered to the
> model, including drained-from-queue ones, with the same allow/deny contract.
>
> **2. Auto-attached open/selected files aren't in the hook payload.** A file that's open or
> selected (no `@`-mention) is auto-inlined as an `<attached_files>` block in the request,
> but that content never appears in the `beforeSubmitPrompt` payload — the hook sees only the
> typed prompt and `type:"rule"` path refs. So a hook cannot scan or deny the attached file.
> *Request:* include auto-attached file content (or resolvable paths + line ranges) in the
> `beforeSubmitPrompt` payload, **or** add a documented setting to disable auto-inclusion of
> open/selected files.
>
> Either change lets a hook enforce policy on these paths instead of only observing the leak.
> Happy to share reproduction details.
