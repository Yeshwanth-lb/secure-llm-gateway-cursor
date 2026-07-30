# ChatGPT (OpenAI) PII-redaction — extension spec

> **For the implementing agent (Cursor):** this is the spec. Implement it in the existing
> extension under `extension/`, reusing the Gemini extension's core. Read
> `extension/README.md`, `scripts/gemini_imp.md`, and the "Gemini-web extension (Phase G)"
> sections of the repo-root `CLAUDE.md` first — the architecture, the security invariants,
> and the hard-won gotchas all carry over. Work incrementally, keep every existing test
> green, and **surface anything that can't be matched rather than faking it.**

---

## 1. Goal

Add **chatgpt.com** (OpenAI ChatGPT) as a supported surface to the existing DOM-level
PII-redaction extension, with the **same behavior and same security model** as the Gemini
surfaces. Do **not** change the redaction logic or the gateway. Do **not** regress any
Gemini surface.

---

## 2. Behavior to preserve (identical to the Gemini surfaces)

On chatgpt.com the extension must:

1. **Intercept the user's submit** in the capture phase and fully kill the original event
   (`preventDefault` + `stopImmediatePropagation`) — reuse `src/interceptor-core.js`.
2. Send the prompt text to the **local gateway** `http://127.0.0.1:8001` (`POST /redact`)
   via the background worker, get the redacted text back.
3. **Write the redacted text into the composer** so ChatGPT's editor model updates (see
   §5 — this is the hard part on ChatGPT).
4. **Re-fire** a synthetic submit, loop-guarded so our own event isn't re-intercepted.
5. Watch the DOM until the assistant reply settles, then `POST /log-turn` (raw prompt +
   captured reply; the gateway redacts + stores redacted only).

Plus the DOM-independent **tripwire** (`src/tripwire.js`) must fail-close ChatGPT's send
endpoint: if an outbound request to ChatGPT's conversation endpoint still carries raw PII,
abort it. Security invariants (never send raw PII, never persist it, fail closed when the
composer can't be found or the gateway is down, gateway reached only from the background)
are **unchanged** and must hold on chatgpt.com too.

---

## 3. Reuse map — DO NOT fork or rewrite these

These are provider-agnostic; reuse as-is (route any `chrome.*` through `src/browser-api.js`):

| File | Role — reused unchanged |
|---|---|
| `src/interceptor-core.js` | loop guard / intercept decision |
| `src/composer-finder.js` | pure composer scorer (heuristic fallback) |
| `src/composer-learn.js` | focus/fingerprint learning |
| `src/response-finder.js` | pure reply ranking (+ `looksLikeMetadata`/`looksLikeBoilerplate`) |
| `src/response-capture.js` | shape-based reply capture glue |
| `src/redact-client.js` | `/redact` + `/log-turn` fetch wrapper |
| `src/background.js`, `src/content-bridge.js`, `src/loader.js`, `src/browser-api.js` | messaging / config / MAIN-world injection |

**The gateway needs ZERO changes.** The redaction engine scrubs any text, and
`provider: "openai"` is already a valid `LogEntry` provider (Cursor logs as `openai`). Log
ChatGPT turns with `provider: "openai"`, `source: "chatgpt-web-extension"`; the console
already labels non-provider sources for display.

**ChatGPT-specific work lives in a small site adapter** — do NOT bolt ChatGPT selectors
onto the Gemini-specific `composer.js` in a way that risks the Gemini path. Prefer a
per-site adapter object (composer selectors, send-button, response selectors, endpoints,
model selector, and the text-write strategy) chosen by hostname, so gemini.google.com and
chatgpt.com each get their own selectors while sharing the finder/interceptor/tripwire
machinery. If a full adapter refactor is too large, at minimum guard all ChatGPT selectors
by `location.hostname` so they never run on a Gemini surface, and vice-versa.

---

## 4. ChatGPT DOM specifics (VERIFY every selector against the live page — they change often)

Open chatgpt.com and confirm each in DevTools before trusting it:

- **Hosts:** `https://chatgpt.com/*` and `https://chat.openai.com/*` (old domain still
  redirects for some users) → add to manifest `matches` + `web_accessible_resources`
  matches. `host_permissions` for the gateway is unchanged (`127.0.0.1:8001`).
- **Composer:** a **ProseMirror `contenteditable` div**, id `#prompt-textarea`
  (`div#prompt-textarea[contenteditable="true"]`). Older builds used a `<textarea>` — handle
  both (textarea path is trivial; ProseMirror is the risk — §5).
- **Send button:** `button[data-testid="send-button"]` (has also been
  `[data-testid="fruitjuice-send-button"]`; and while generating it becomes a **stop**
  button `[data-testid="stop-button"]` — reuse that for `isGenerating()`).
- **Submit gesture:** Enter without Shift, or the send button — same two paths as Gemini.
- **Assistant reply:** `div[data-message-author-role="assistant"] .markdown` (the streamed
  answer). User messages: `div[data-message-author-role="user"]`. These `data-message-author-role`
  attributes are stable-ish and semantic — good for the response selectors (unlike Gemini's
  obfuscated panels). Add them to the response-selector list for the ChatGPT adapter.
- **Model name:** the model switcher button near the top-left (`[data-testid="model-switcher-dropdown-button"]`
  or the header button text) → `getModel()` for the log row.

- **Tripwire endpoint:** ChatGPT sends the message via **fetch POST** to
  `https://chatgpt.com/backend-api/conversation` (also `/backend-api/f/conversation`). Add
  a ChatGPT entry to the tripwire's inspected-URL list (`DEFAULT_*_ENDPOINTS` /
  `shouldInspectUrl`) so a raw-PII body there is aborted. **Confirm the exact path in the
  Network tab** — OpenAI changes it.

---

## 5. THE make-or-break: writing text into ProseMirror (test this FIRST)

ChatGPT's composer is **ProseMirror**, which keeps its **own** document model and *ignores
/ overwrites direct DOM edits*. So the Gemini path (`document.execCommand("insertText")` /
setting `textContent`) will very likely update the visible text but **NOT** ProseMirror's
model — exactly the failure we hit on Firefox's Gemini Workspace panel: ChatGPT would then
send the **raw** text, the tripwire would abort it ("something went wrong"), and no message
goes through. **This would break on every browser, not just Firefox.**

The reliable way to inject text into ProseMirror is a **synthetic paste**, which ProseMirror
handles through its own paste pipeline:

```js
// focus, select-all, then paste the redacted text as text/plain
el.focus();
document.execCommand?.("selectAll", false);           // or a Selection/Range over el
const dt = new DataTransfer();
dt.setData("text/plain", redactedText);
el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
```

If the paste event doesn't take, try a `beforeinput` with `inputType: "insertReplacementText"`
+ `data` (modern ProseMirror listens to `beforeinput`). **Whatever you use, VERIFY it before
building the rest:** type a PII prompt, run the write, and confirm the OUTGOING
`/backend-api/conversation` request body contains the **token, not the raw value** (Network
tab). If ProseMirror won't sync from a synthetic write at all, STOP and report it — do not
ship a version that relies on the tripwire aborting every PII send (that's fail-closed, not
redaction, and it breaks the UX). This is the single highest-risk item; prove it first.

---

## 6. Arming

`content-main.js` currently arms only in the top frame or a `chat.google.com` subframe
(`isArmableFrame`) and only fails closed once a composer has been seen (`sawComposer`).
Extend arming to include **chatgpt.com** (top frame). ChatGPT is a single top-level SPA — no
cross-origin composer iframe like Gmail, so `all_frames` isn't needed for it (keep it for
the Gemini Workspace panels). Keep the `sawComposer` gate so ChatGPT pages that momentarily
lack a composer don't block unrelated input.

---

## 7. Deliverables

- Manifest: chatgpt.com + chat.openai.com in `matches` and `web_accessible_resources`.
- A ChatGPT site adapter (composer/send/response/model selectors + endpoints + the
  ProseMirror-safe `writeText`), selected by hostname; Gemini path untouched.
- Tripwire: ChatGPT conversation endpoint added to the inspected list.
- `content-main.js`: arm on chatgpt.com; `getModel()`/response capture use the adapter.
- Turn logging as `provider: "openai"`, `source: "chatgpt-web-extension"`.
- Tests: add a headless unit/e2e that drives the REAL content script against a **fake
  ChatGPT page** reproducing the ProseMirror composer + the `data-message-author-role`
  reply DOM (mirror `extension/test/e2e/fake-panel.html` + `run-response.mts`), asserting:
  redacted token on the wire, zero raw PII, exactly one send, gateway-down → blocked, and
  reply captured. Keep `npm test`, `npm run test:gemini-e2e`, `npm run test:gemini-response-e2e`,
  `npm run test:firefox-e2e` all green.
- `CLAUDE.md` ledger entry (new Phase-G row) + a README section.

## 8. Acceptance criteria

- On real chatgpt.com: a PII prompt leaves as a **redacted token on the wire** (verify the
  `/backend-api/conversation` request body in the Network tab), the reply is captured in the
  gateway Traffic Inspector (`http://127.0.0.1:8001`) as a `provider: openai` CHAT row, and
  **normal (non-PII) messages send and reply normally** (do NOT break normal sends — that
  was the Firefox-Workspace failure mode; the ProseMirror write must actually sync).
- If the gateway is down, the send is **blocked** (fail closed), not leaked.
- gemini.google.com (all browsers) and Chrome Gemini Workspace behavior are **unchanged**;
  all existing suites pass.
- No new runtime dependency; **no change to `src/` (the gateway) or the redaction logic.**

## 9. Do NOT

- Do not move the gateway fetch out of the background.
- Do not add any runtime dependency.
- Do not change the redaction rules, the intercept/fail-closed logic, or the tripwire's
  detection (only ADD ChatGPT's endpoint to the inspected list).
- Do not ship if the ProseMirror write can't sync the model (that degrades to
  tripwire-only = broken UX). Report it instead.
- Do not let ChatGPT selectors run on Gemini surfaces or vice-versa (guard by hostname).
