# Grok (xAI) PII-redaction — extension spec

> **For the implementing agent (Cursor):** this is the spec. Implement it in the existing
> extension under `extension/`, reusing the same core the Gemini and ChatGPT surfaces use.
> Read `extension/CHATGPT_EXTENSION.md`, `extension/src/site-adapter.js`, `extension/README.md`,
> and the "Gemini-web extension (Phase G)" + "ChatGPT surface (Phase P)" sections of the
> repo-root `CLAUDE.md` first — the architecture, the security invariants, and the hard-won
> gotchas all carry over. **Grok is the easiest surface yet: its composer is the SAME editor
> family as ChatGPT (ProseMirror/Tiptap), so the ChatGPT `writeText` path is reused as-is.**
> Work incrementally, keep every existing test green, and **surface anything that can't be
> matched rather than faking it.**

---

## 1. Goal

Add **grok.com** (xAI Grok) as a supported surface to the existing DOM-level PII-redaction
extension, with the **same behavior and same security model** as the Gemini and ChatGPT
surfaces. Do **not** change the redaction logic or the gateway. Do **not** regress any
existing surface. This is almost entirely a **new `GROK_ADAPTER` in
`extension/src/site-adapter.js`** + a manifest entry + a tripwire endpoint + arming — no
new machinery.

---

## 2. Why this is low-risk

The two things that made ChatGPT hard are already solved and **confirmed for Grok**:

1. **The composer editor.** Grok's composer is **Tiptap, which is ProseMirror** — the exact
   editor ChatGPT uses. Confirmed live via probe:
   `{"tag":"div","ce":"true","cls":"tiptap ProseMirror w-full px-2 bg-transparent focus:outline-","anyProseMirror":true}`.
   So the **ChatGPT adapter's ProseMirror-safe `writeText` path works unchanged** — the hard,
   already-proven part. (The Gemini `execCommand("insertText")` write also happens to be what
   syncs ProseMirror — see CHATGPT_COVERAGE.md — so the existing write path in `composer.js`
   is correct here too. Still VERIFY on the wire per §5.)
2. **The send endpoint** (for the tripwire) is **confirmed** — see §4.

The one Grok-specific unknown is the **reply DOM**, which has **no stable semantic attribute**
(Grok uses Tailwind utility classes + streaming `<span class="animate-gaussian">` word spans,
not ChatGPT's `data-message-author-role`). That is exactly the case the **shape-based capture
already handles** for Gemini's obfuscated panels — reuse it, don't invent a brittle selector.

---

## 3. Behavior to preserve (identical to the other surfaces)

On grok.com the extension must:

1. **Intercept the user's submit** in the capture phase and fully kill the original event
   (`preventDefault` + `stopImmediatePropagation`) — reuse `src/interceptor-core.js`.
2. Send the prompt text to the **local gateway** `http://127.0.0.1:8001` (`POST /redact`) via
   the background worker, get the redacted text back.
3. **Write the redacted text into the ProseMirror composer** using the existing `writeText`
   (§5).
4. **Re-fire** a synthetic submit, loop-guarded so our own event isn't re-intercepted.
5. Watch the DOM until the assistant reply settles, then `POST /log-turn` (raw prompt +
   captured reply; the gateway redacts + stores redacted only).

Plus the DOM-independent **tripwire** (`src/tripwire.js`) must fail-close Grok's send
endpoint: if an outbound request to Grok's conversation endpoint still carries raw PII, abort
it. All security invariants (never send raw PII, never persist it, fail closed when the
composer can't be found or the gateway is down, gateway reached only from the background) are
**unchanged** and must hold on grok.com too.

---

## 4. Grok DOM + network specifics (all CONFIRMED LIVE 2026-07-31 unless noted)

- **Host:** `https://grok.com/*` → add to manifest `matches`, `web_accessible_resources`
  matches, and (background) `host_permissions` is unchanged (`127.0.0.1:8001`). Grok is a
  single top-level SPA (like ChatGPT) — **no cross-origin composer iframe**, so `all_frames`
  is not needed for it (keep `all_frames:true` overall for the Gemini Workspace panels; it
  does no harm here). *(Do NOT add `x.com`/`twitter.com` Grok in this pass — different DOM,
  scope it separately later.)*

- **Composer:** Tiptap/ProseMirror contenteditable —
  `div.tiptap.ProseMirror[contenteditable="true"]`. Selectors, most-specific first:
  ```
  div.tiptap.ProseMirror[contenteditable="true"]
  div.ProseMirror[contenteditable="true"]
  ```
  (No `<textarea>` fallback — Grok builds the request from the ProseMirror model, same as
  ChatGPT. Writing a textarea would ship raw. Do not list one.)

- **Send button:** verify the exact selector live (Grok uses unlabeled icon buttons). Try, in
  order: `button[type="submit"]`, `button[aria-label*="Submit" i]`, `button[aria-label*="Send" i]`,
  then a form submit / Enter-without-Shift. **The Enter path is the reliable one** — same as
  the other surfaces. While generating, the send button becomes a **stop** button (a square /
  `aria-label*="Stop"`) — reuse for `isGenerating()`.

- **Send endpoint (tripwire) — CONFIRMED via global Network search for the typed text:**
  ```
  POST https://grok.com/rest/app-chat/conversations/{conversationId}/load-responses
       body: {"message":"<the user's text>","sender":"human", ...}      ← follow-up messages
  POST https://grok.com/rest/app-chat/conversations/new                  ← first message of a new chat
  ```
  The user's typed text ships as the JSON `"message"` field with `"sender":"human"`.
  **Tripwire fragment (robust to the conversation id):**
  ```
  /rest/app-chat/conversations/
  ```
  Any POST to that path carrying raw PII must be aborted. (Listing the two specific suffixes
  `load-responses` and `conversations/new` is fine too, but the shared prefix above covers
  both and any future per-conversation path.)

- **Assistant reply:** **NO stable semantic selector.** Tailwind classes rotate; the streamed
  answer is built from `<span class="animate-gaussian">…</span>` word spans inside an
  obfuscated-class bubble. So:
  - Put a couple of *best-effort* selectors in `responseSelectors` to try first (VERIFY live;
    e.g. a message/markdown container class you can confirm), but
  - **Rely on the shape-based capture** (`response-capture.js` + `response-finder.js`) exactly
    as Gemini's Gmail/Drive/Chat panels do. It anchors on the submitted text and ranks the
    streaming, non-interactive block that follows it. This is the correct, already-built tool
    for a class-name-free reply. Do NOT ship a brittle "last div" guess.

- **Model name:** the tier selector near the composer shows **"Fast" / "Expert"** (Grok also
  has "Fast"/"Expert"/model dropdown). Find its button and read the label for `getModel()`.
  Verify the selector live; fall back to `fallbackModel: "grok"`. **Do NOT body-scan** for the
  model (`modelBodyPattern: null`) — the page body is the transcript, so a stray tier word in
  a reply would be logged as the model (same rule as ChatGPT).

---

## 5. Writing text into ProseMirror (already solved — just verify)

Grok = ProseMirror, so reuse the **existing** `composer.writeText` path (the one that ships
for ChatGPT: focus → select existing content → `execCommand("insertText")`, which ProseMirror
absorbs into its model). **Do not write a hidden textarea.**

**VERIFY on the wire before building the rest** (this is the one mandatory live check): type a
PII prompt, run the write, and confirm the outgoing
`/rest/app-chat/conversations/.../load-responses` (or `/conversations/new`) request body has
the **token, not the raw value** in the `"message"` field (Network tab → the request →
Payload). If — and only if — ProseMirror won't sync from the existing write, try a synthetic
`paste` (`DataTransfer` + `ClipboardEvent("paste")`) as documented in CHATGPT_EXTENSION.md §5,
and if THAT also fails, STOP and report it (do not ship a tripwire-only version — that is
fail-closed, not redaction, and breaks the UX).

---

## 6. Arming

Extend `content-main.js` `isArmableFrame` to arm on **grok.com** (top frame). Keep the
`sawComposer` gate so a Grok page that momentarily lacks a composer doesn't block unrelated
input. No iframe handling needed for Grok.

---

## 7. The `GROK_ADAPTER` (the bulk of the work)

Add to `extension/src/site-adapter.js`, and register it in the `ADAPTERS` array. Shape mirrors
`CHATGPT_ADAPTER`:

```js
export const GROK_ADAPTER = {
  id: "grok",
  // xAI has no dedicated Provider enum member and the enum is FROZEN. Log under
  // the "openai" API-family bucket (as Cursor/ChatGPT do) and DISTINGUISH by source;
  // the console labels rows by source.
  provider: "openai",
  source: "grok-web-extension",
  hosts: ["grok.com"],

  composerSelectors: [
    'div.tiptap.ProseMirror[contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
  ],

  sendButtonSelectors: [
    'button[type="submit"]',
    'button[aria-label*="Submit" i]',
    'button[aria-label*="Send" i]',
  ],
  liveSendSelector:
    'button[type="submit"], button[aria-label*="Submit" i], button[aria-label*="Send" i]',
  stopSelector: 'button[aria-label*="Stop" i], button[data-testid*="stop" i]',

  modelSelectors: [/* VERIFY LIVE — the Fast/Expert tier button near the composer */],
  modelBodyPattern: null,
  fallbackModel: "grok",
  normalizeModel(text) {
    const t = String(text).replace(/\s+/g, " ").trim();
    return t ? "grok-" + t.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "") : null;
  },

  // No stable semantic reply attribute — shape-based capture handles it. Put any
  // selector you can CONFIRM live first; the shape fallback covers the rest.
  responseSelectors: [/* best-effort, VERIFY LIVE; may be left empty to force shape capture */],
  responseLabelOnly: null,
  responseLabelPrefix: null,

  // Grok file-upload path NOT probed yet — keep the guard OFF until probed the same
  // way ChatGPT was (extension/test/e2e/upload-probe-console.js).
  uploadGuard: false,
  uploadEndpoints: [],

  // CONFIRMED live: the message POST. The shared prefix covers both the follow-up
  // (`/{id}/load-responses`) and the new-chat (`/new`) paths, robust to the id.
  tripwireEndpoints: ["/rest/app-chat/conversations/"],
};
```

Then `const ADAPTERS = [CHATGPT_ADAPTER, GROK_ADAPTER, GEMINI_ADAPTER];` (GEMINI stays last —
it is the fail-safe default for unknown hosts).

---

## 8. Deliverables

- Manifest: `grok.com` in `matches` and `web_accessible_resources` matches.
- `GROK_ADAPTER` in `site-adapter.js`, registered in `ADAPTERS`, selected by hostname; Gemini
  and ChatGPT paths untouched.
- Tripwire: `/rest/app-chat/conversations/` added via the adapter's `tripwireEndpoints`
  (already read from the adapter — no `tripwire.js` change beyond confirming it uses
  `currentAdapter().tripwireEndpoints`).
- `content-main.js`: arm on grok.com (`isArmableFrame`); `getModel()`/response capture already
  read the adapter.
- Turn logging as `provider: "openai"`, `source: "grok-web-extension"`.
- Tests: add `tests/phase-grok.test.ts` mirroring `tests/phase-chatgpt.test.ts` — host scoping
  (a Gemini `ql-editor` decoy never wins on grok.com; ChatGPT endpoints don't inspect Grok's
  and vice-versa), model-label → slug, the tripwire fragment aborts on the Grok endpoint, and
  a `/log-turn` round trip stores no raw PII as `openai`/`grok-web-extension`. Optionally a
  fake-grok e2e mirroring `run-response.mts` if time permits. Keep `npm test`,
  `npm run test:gemini-e2e`, `npm run test:chatgpt-e2e`, `npm run test:firefox-e2e` green.
- Rebuild the cross-browser packages (`npm run ext:build`) so `extension/build/{firefox,safari}`
  aren't stale — `tests/phase-cross-browser.test.ts` fails on a stale package.
- `CLAUDE.md` ledger entry (new Phase row, Phase S — "Grok surface") + a README section.

---

## 9. Acceptance criteria

- On real grok.com: a PII prompt leaves as a **redacted token on the wire** — verify the
  `/rest/app-chat/conversations/.../load-responses` (or `/conversations/new`) request body's
  `"message"` field in the Network tab — the reply is captured in the gateway Traffic Inspector
  (`http://127.0.0.1:8001`) as a `provider: openai` / `source: grok-web-extension` CHAT row,
  and **normal (non-PII) messages send and reply normally** (the ProseMirror write must
  actually sync — that was the Firefox-Workspace failure mode).
- If the gateway is down, the send is **blocked** (fail closed), not leaked.
- gemini.google.com, Chrome Gemini Workspace, and chatgpt.com behavior are **unchanged**; all
  existing suites pass.
- No new runtime dependency; **no change to `src/` (the gateway) or the redaction logic.**

## 10. Do NOT

- Do not move the gateway fetch out of the background.
- Do not add any runtime dependency.
- Do not change the redaction rules, the intercept/fail-closed logic, or the tripwire's
  detection (only ADD Grok's endpoint via the adapter).
- Do not write a hidden textarea (Grok builds the request from ProseMirror — that ships raw).
- Do not ship a brittle reply selector; use the shape-based capture for Grok's reply.
- Do not let Grok selectors run on Gemini/ChatGPT surfaces or vice-versa (adapter is
  hostname-scoped — keep it that way).
- Do not ship if the ProseMirror write can't sync the model. Report it instead.
