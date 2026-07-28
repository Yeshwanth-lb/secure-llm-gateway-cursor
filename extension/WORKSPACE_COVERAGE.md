# Gemini Extension — Google Workspace Coverage (Session Report)

Complete record of extending the Gemini PII-redaction extension from
`gemini.google.com` to the Google Workspace Gemini surfaces, plus the assistant-
response capture work. Written 2026-07-21/22. Companion to
[`REBUILD_PLAYBOOK.md`](./REBUILD_PLAYBOOK.md) (the blocker list),
[`BUILD_FROM_SCRATCH.md`](./BUILD_FROM_SCRATCH.md) (full source), and
[`README.md`](./README.md).

---

## 1. Goal

Org-level PII control. Employees can paste PII into any Google surface that has a
Gemini input; redact the **prompt before it leaves the browser** on every such
surface, not just `gemini.google.com`. Additive only — the existing gemini.google.com
behavior must not regress.

---

## 2. How coverage works (two layers)

1. **DOM interception (primary, clean redaction).** On submit: kill the original
   send → send text to the local gateway `POST /redact` → write the redacted
   (tokenized) text back into the composer → re-fire the send. One-way tokens,
   fail-closed. This gives clean token rewrite where we've tuned selectors.
2. **Tripwire (secondary, universal fail-closed net).** A page-world fetch/XHR
   wrapper, endpoint-scoped to Gemini's generate endpoints and Luhn-checked. If a
   request to a known Gemini endpoint still carries raw PII (i.e. the DOM path
   broke), it is **aborted** — blocked, never leaked. DOM-independent, so it
   survives Gemini UI changes.

The gateway (`src/server.ts`, loopback `127.0.0.1:8001`) is reused unchanged:
`/redact`, `/log-turn`, and `chrome-extension://` origin allowed on those hook
endpoints only (`isExtensionOrigin`).

---

## 3. What changed (files)

- **`manifest.json`** — added Workspace hosts to both `content_scripts.matches`
  and `web_accessible_resources.matches`: `mail.google.com`, `docs.google.com`
  (serves Docs/Sheets/Slides/Forms), `drive.google.com`, `chat.google.com`
  (kept `gemini.google.com` first).
- **`src/composer.js`**
  - `COMPOSER_SELECTORS`: added the Workspace composer
    `div[contenteditable="true"][aria-label*="Ask Gemini" i]`, ordered **before**
    the generic `role=textbox`/`textarea` catch-alls (critical — see §5.3).
  - `RESPONSE_SELECTORS`: added the Workspace assistant-reply class
    `.appsElementsSidekickAgentMessageBubbleContent` (+ substring variants).
- **`src/content-main.js`** — `fireSubmit` rewritten to pick the **enabled +
  visible** send button and dispatch a **full pointer sequence** (see §5.1, §5.2);
  `CONFIG.debug` tracing added in `onSubmitEvent` (off by default) that pinpointed
  the Sheets bug.
- **`src/tripwire.js`** — `DEFAULT_GEMINI_ENDPOINTS` extended with the Workspace
  generate endpoint (`streamGenerate` lowercase, `appsgenaiservice` host).

---

## 4. Coverage matrix (live-verified)

Verification method: **DevTools → Network → search the raw email string → "No
matches found"** proves the raw never left the browser (only the token did). This
is the authoritative test — the on-screen bubble showing a token is NOT proof (a
model-sync bug once showed a token in the DOM while sending raw).

| Surface | Host | Prompt redaction | Response capture | Notes |
|---|---|:---:|:---:|---|
| Gemini web | gemini.google.com | ✅ wire-proven | ✅ | Quill composer; original surface |
| Gmail | mail.google.com | ✅ wire-proven | ❌ (none) | obfuscated reply DOM |
| Docs | docs.google.com | ✅ wire-proven | ✅ | appsElements (semantic) |
| Sheets | docs.google.com | ✅ wire-proven | ✅ | appsElements |
| Slides | docs.google.com | ✅ verified | ✅ | appsElements |
| Drive | drive.google.com | ✅ verified | ❌ (none) | obfuscated reply DOM (same as Gmail) |
| Chat | chat.google.com | ✅ wire-proven | ❌ (none) | different obfuscated DOM |
| Claude Code | (gateway, not extension) | ✅ wire-proven | ✅ | network hop, separate mechanism |

**Prompt redaction (the security control) works on all seven browser surfaces.**
Response capture is a cosmetic inspector view (see §6).

---

## 5. The hard-won findings (each cost real debugging)

### 5.1 Disabled-decoy send button
Workspace renders **two** `aria="Submit"` buttons — a disabled decoy and the real
enabled one. `findSendButton` grabbed the first (disabled); clicking a dead button
did nothing → send silently stuck, redacted text just sat in the composer. **Fix:**
`fireSubmit` picks a candidate that is BOTH `!disabled` AND visible
(`offsetParent !== null`), scoped to the composer container.

### 5.2 Gm3 Material buttons ignore a bare synthetic click
A single `new MouseEvent("click")` (which worked on gemini.google.com) does nothing
on Workspace's Gm3 buttons. **Fix:** dispatch the full sequence
`pointerdown → mousedown → pointerup → mouseup → click` (each tagged synthetic so
the loop guard ignores our own re-fire). Superset of the old single click, so
gemini.google.com still works.

### 5.3 Stray-textbox selector-order trap (Sheets)
Sheets renders empty `div[contenteditable="true"][role="textbox"]` decoys. Because
the generic `role=textbox` selector sat **before** the Workspace `aria*="Ask Gemini"`
selector in `COMPOSER_SELECTORS`, `findComposer` matched an **empty** decoy →
`readText` returned `""` → `onSubmitEvent` bailed on "empty text" → the send went
out **UNREDACTED**. Symptom was subtle: interception fired, composer "found", but
`readText len=0`. **Fix:** order the specific `aria*="Ask Gemini"` selector before
the generic catch-alls. **Lesson: a specific composer selector must always precede
generic contenteditable catch-alls, or an empty decoy silently defeats redaction.**
(`CONFIG.debug` tracing in `onSubmitEvent` is what surfaced this.)

### 5.4 Quill / appsElements async model-sync
Writing the redacted text with a bare `textContent =` leaves the framework's own
model (Quill Delta / appsElements) stale, so the app submits the raw text even
though the DOM shows the token. **Fix:** `writeText` uses `execCommand("insertText")`
on a select-all'd composer + a 120 ms yield before re-firing so the model absorbs
the change. (Carried over from the gemini.google.com work; applies to Workspace too.)

### 5.5 Endpoint differs per surface (tripwire scope)
gemini.google.com uses `StreamGenerate`/`BardFrontendService`; Workspace uses
lowercase `streamGenerate` on the `appsgenaiservice` host. `includes` is
case-sensitive, so both are listed in `DEFAULT_GEMINI_ENDPOINTS`. Chat uses its own
message endpoints (`create_message`/`create_topic`) — deliberately left OUT of the
tripwire scope (Chat's DOM path is proven; scoping those would gate normal Chat
messages).

### 5.6 Three different Gemini panel DOMs (response capture)
When capturing the assistant reply for the inspector, we found Google ships **three
distinct implementations**:
- **Semantic `appsElements`** — gemini.google.com, Docs, Sheets, Slides. Reply is
  in `.appsElementsSidekickAgentMessageBubbleContent`. Stable → response captured.
- **Obfuscated build A** — Gmail + Drive. Reply in rotating classes
  (`.rnc2Gd`, `.NA2Vme[role=listitem]`, `.k3ABge[role=list]`), interleaved with
  suggestion chips.
- **Obfuscated build B** — Chat. Different rotating classes (`.muAele`, `.DbJhs`,
  `.rHUJK`…), no `role` signals.

The obfuscated classes **rotate every Google deploy**, so hardcoding them is
worthless. A role-based fallback (`last [role="listitem"]`) was tried and
**reverted** — it reliably grabbed a **suggestion chip** ("Show me my unread
emails") instead of the reply, i.e. logged the wrong text as the assistant output.
**A wrong pairing in an audit log is worse than a blank one**, so on obfuscated
surfaces we log the prompt (redacted) and leave the response empty rather than
guess.

---

## 6. Scope boundaries (what this does NOT do)

- **One-way redaction.** The prompt is scrubbed outbound; responses are not
  rewritten. Fixed tokens, no restore.
- **Response capture is cosmetic**, not a security function. It shows in the
  inspector only where Google's DOM is stable (the 4 appsElements surfaces); blank
  elsewhere. What is captured is stored **redacted** by the gateway anyway.
- **Gemini reading your own Workspace data server-side is NOT interceptable.** When
  you ask "summarize my inbox," Gemini reads Gmail on Google's servers and returns
  content — that data never passes through the composer we intercept. No browser
  extension can gate it; only Google-side controls (disabling Gemini's Workspace
  data access / Admin policy) can.
- **No Gemini target = nothing to do:** Calendar and Forms have **no** Ask-Gemini
  composer for this account → not covered because there's nothing to cover.
- **Not yet covered (out of scope this pass):** Vids (`vids.google.com`), Workspace
  Studio (`studio.workspace.google.com`), NotebookLM, Meet, AI Studio — these have
  Gemini inputs on hosts not yet in the manifest. Planned as the org-wide expansion
  (enumerate hosts + universal tripwire net).

---

## 7. Git state

- **Branch:** `phase/gemini-workspace-extension` (off `main`, which stays clean).
- **Commit `bc58d7a`** (pushed to `origin` = private repo
  `Yeshwanth-lb/secure-llm-gateway-cursor`): the extension + Workspace 6-app prompt
  redaction + tripwire + gateway endpoints + tests + docs. Suite 109/109, e2e 8/8.
- **Uncommitted** (working tree, after `bc58d7a`): the response-capture changes in
  `composer.js` (RESPONSE_SELECTORS for the appsElements surfaces; no brittle
  fallback) and the `CONFIG.debug` tracing in `content-main.js` (default off).
  Suite still 109/109, e2e 8/8 — ready to commit as a follow-up.
- **Restore anytime:** `git fetch origin && git checkout phase/gemini-workspace-extension`
  (or `git reset --hard origin/phase/gemini-workspace-extension`).
- Note: the commit's `Co-Authored-By` email shows as `[REDACTED_PII_EMAIL]` because
  the gateway redacts the model's own output — cosmetic, amendable outside the gateway.

---

## 8. How to verify / re-test any surface

1. Start the gateway (`127.0.0.1:8001`) and reload the extension
   (`chrome://extensions` ↻) — **then reload each open tab** (extension reload does
   not re-inject into already-open tabs; this caused several false "not working"
   readings).
2. Open the surface → Ask Gemini → type `my email is <addr>` → send.
3. **Network tab → 🔍 search the raw address → "No matches found" = clean.**
   (Bubble token alone is not proof.)
4. For a new/untuned surface, use the composer/reply probes documented in the
   session (dump `aria-label`/contenteditable, or find the reply element by a word
   in it and print its ancestor chain) to derive selectors.

---

## 9. What's next (optional)

- Commit + push the response-capture follow-up to the branch.
- Org-wide host expansion: add Vids / Workspace Studio / NotebookLM / Meet / AI
  Studio (enumerated hosts) + discover each generate endpoint for the tripwire net.
  See the plan in `.claude/plans/` (org-wide Gemini coverage).
- Reconcile the local gateway (a duplicate service + manual instance were both
  contending for port 8001 during testing — run one managed instance).
