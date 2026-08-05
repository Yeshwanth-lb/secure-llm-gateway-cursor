# DeepSeek (chat.deepseek.com) PII-redaction — extension spec

> **For the implementing agent (Cursor):** this is the spec. Implement it in the existing
> extension under `extension/`, reusing the same core the Gemini/ChatGPT/Grok surfaces use.
> Read `extension/GROK_EXTENSION.md`, `extension/CHATGPT_EXTENSION.md`,
> `extension/src/site-adapter.js`, and the Phase-G/P/S sections of the repo-root `CLAUDE.md`
> first. This is a **new `DEEPSEEK_ADAPTER`** in `site-adapter.js` + a manifest entry + a
> tripwire endpoint + arming — no new machinery. **Read §5 (encrypted body) before anything
> else — it changes the security reasoning for this surface.**

---

## 1. Goal

Add **chat.deepseek.com** as a supported surface, same behavior and same security model as the
other surfaces. Do **not** change the redaction logic or the gateway. Do **not** regress any
existing surface.

---

## 2. Why this is the EASIEST composer, but a WEAKER backstop

Two live findings (probed 2026-08-03, Chrome, signed in) define the work:

1. **Composer is a plain `<textarea>`** — probe returned
   `{"tag":"TEXTAREA","ce":null,"isTextarea":true,"anyProseMirror":false,"anyLexical":false}`.
   No ProseMirror, no Lexical. So the **existing textarea write path** in `composer.writeText`
   (native value setter + `input` event) is all that's needed — the simplest, most reliable
   write of any surface. This is good.

2. **DeepSeek encrypts/obfuscates the outgoing request body** — see §5. This makes the
   DOM-independent **tripwire backstop blind** on DeepSeek (it scans the outbound body for raw
   PII; it cannot match ciphertext). So on this surface the protection rests **entirely on the
   primary intercept + textarea write**. Because a textarea write is reliable (unlike the
   ProseMirror surfaces), that is acceptable — but it must be **verified live** (§8), and the
   limitation must be documented in the ledger, not hidden.

---

## 3. Behavior to preserve (identical to the other surfaces)

1. **Intercept the submit** in the capture phase, fully kill the original event
   (`preventDefault` + `stopImmediatePropagation`) — reuse `src/interceptor-core.js`.
2. `POST /redact` to the local gateway (`http://127.0.0.1:8001`) via the background worker.
3. **Write the redacted text into the `<textarea>`** using the existing textarea path in
   `composer.writeText` (native `HTMLTextAreaElement` value setter + dispatched `input` so
   DeepSeek's React state updates — a bare `.value =` will be overwritten on the next render
   and ship the RAW text).
4. **Re-fire** a synthetic submit, loop-guarded so our own event isn't re-intercepted.
5. Watch the DOM until the reply settles, then `POST /log-turn`.

Security invariants unchanged: never send raw PII, never persist it, fail closed when the
composer can't be found or the gateway is down, gateway reached only from the background.

---

## 4. DeepSeek DOM + network specifics (probed live 2026-08-03 — VERIFY before trusting)

- **Host:** `https://chat.deepseek.com/*` → add to manifest `matches`,
  `web_accessible_resources` matches. `host_permissions` (gateway) unchanged. Single top-level
  SPA — **no composer iframe**, so no `all_frames` requirement for it.

- **Composer:** a `<textarea>` (the probed one had a hashed class
  `_27c9245 ds-scroll-area …` — **do not select on that**, it rotates). Use a STABLE handle:
  ```
  textarea#chat-input                          (DeepSeek's known id — verify it's present)
  textarea[placeholder*="Message DeepSeek" i]  (the visible placeholder — stable fallback)
  ```
  List both; the composer-finder heuristic covers the rest. **No contenteditable path.**

- **Send button:** the up-arrow button at the composer's right. Unlabeled — verify a selector
  live (try `button[type="submit"]`, `[role="button"]` near the textarea). The **Enter path**
  (Enter without Shift) is the reliable submit gesture; the button is secondary.

- **Send endpoint (tripwire):** the message send is the request named **`completion`**
  (xhr, ~1.7 kB in the probe). Confirmed path family:
  ```
  POST https://chat.deepseek.com/api/v0/chat/completion
  ```
  **Tripwire fragment:** `/chat/completion`. **CONFIRM the exact path live** (open the
  `completion` request → Headers → Request URL) before shipping; OpenAI-compatible builds
  sometimes use `/chat/completions`.

- **Assistant reply:** DeepSeek wraps each turn in a **`ds-message`** container
  (`<div class="… ds-message …">`), and renders the answer as markdown inside a
  **`.ds-markdown`** block. Best-effort `responseSelectors` (VERIFY live — inspect the
  ASSISTANT bubble, not the user's):
  ```
  .ds-markdown
  .ds-markdown--block
  [class*="ds-markdown"]
  ```
  Keep the **shape-based capture** (`response-capture.js`) as the fallback, as on Grok — the
  `ds-*` classes carry hashed siblings and may not fully resolve.

- **Model name:** the tier label near the composer shows **"Instant"** (also "Thinking", and a
  model switcher). Read it for `getModel()`; `fallbackModel: "deepseek"`. **No body scan**
  (`modelBodyPattern: null`) — the page body is the transcript.

---

## 5. THE key risk — the encrypted request body (read this)

A Network-panel **global search for the exact typed text returned "No matches found"**, and the
request list shows **`create_pow_challenge`** and **`sha3_wasm_bg.*`**. DeepSeek runs a
WASM proof-of-work and **the `completion` body is not plaintext** — the prompt is not visible
on the wire as text.

Consequences, and why the design still holds:

- **Redaction still works.** We intercept and rewrite the **textarea** BEFORE DeepSeek reads it
  to build (and encrypt) the request. DeepSeek then encrypts the **already-redacted** text. The
  raw value never enters the payload. This is the same "scrub at the source, not on the wire"
  model as every other surface — it does not depend on the body being readable.
- **The tripwire backstop is BLIND here.** `tripwire.js` scans the outgoing body for raw PII to
  fail-close if the DOM path ever misses. Against an encrypted body it sees ciphertext and can
  match nothing — so it can neither confirm the redaction nor abort a raw send. On DeepSeek the
  tripwire is therefore **best-effort only**; add the endpoint anyway (harmless, and covers the
  case where DeepSeek ever sends plaintext), but **do not rely on it**.
- **Because the backstop is blind, the primary write MUST be verified.** For a plain textarea
  this is reliable, but §8 makes the live check mandatory: confirm the redacted text is what
  DeepSeek actually sends (the model's reply should reference the TOKEN, not the raw value; and
  the redacted text should remain in the textarea through submit, not get reverted by a React
  re-render). If the textarea write does NOT stick, STOP and report — do not ship relying on a
  tripwire that cannot see this body.

Document this in the ledger as the DeepSeek limitation (mirrors how the Firefox-Workspace and
Cursor-queue limitations are recorded): **redaction enforced at the composer; wire-level
backstop unavailable due to payload encryption.**

---

## 6. Arming

Extend `content-main.js` `isArmableFrame` to arm on **chat.deepseek.com** (top frame). Keep the
`sawComposer` gate. No iframe handling.

---

## 7. The `DEEPSEEK_ADAPTER`

Add to `extension/src/site-adapter.js`, register in `ADAPTERS` (before GEMINI, the fail-safe
default):

```js
export const DEEPSEEK_ADAPTER = {
  id: "deepseek",
  // DeepSeek ships an OpenAI-compatible API and has no member in the FROZEN Provider
  // enum, so it logs under the "openai" bucket; `source` distinguishes it in the console.
  provider: "openai",
  source: "deepseek-web-extension",
  hosts: ["chat.deepseek.com"],

  // Plain <textarea> — the existing textarea write path handles it. NO contenteditable.
  composerSelectors: [
    'textarea#chat-input',
    'textarea[placeholder*="Message DeepSeek" i]',
  ],

  sendButtonSelectors: [
    'button[type="submit"]',
    'div[role="button"]',            // VERIFY LIVE — the up-arrow send control is unlabeled
  ],
  liveSendSelector: 'button[type="submit"]',
  stopSelector: 'button[aria-label*="Stop" i], div[role="button"][aria-label*="Stop" i]',

  modelSelectors: [/* VERIFY LIVE — the "Instant"/"Thinking"/model switcher near the composer */],
  modelBodyPattern: null,
  fallbackModel: "deepseek",
  normalizeModel(text) {
    const t = String(text).replace(/\s+/g, " ").trim();
    if (!t) return null;
    if (/^deepseek/i.test(t)) return slug(t);
    return "deepseek-" + slug(t);   // "Instant" -> "deepseek-instant"
  },

  // Best-effort semantic selectors; shape capture (response-capture.js) is the fallback.
  responseSelectors: ['.ds-markdown', '.ds-markdown--block', '[class*="ds-markdown"]'],
  responseLabelOnly: null,
  responseLabelPrefix: null,

  // Upload flow NOT probed — keep OFF until measured the same way (upload-probe-console.js).
  uploadGuard: false,
  uploadEndpoints: [],

  // The message send is the `completion` request. VERIFY the exact path live (could be
  // `/chat/completions`). NOTE: the body is ENCRYPTED (see §5) so this backstop is
  // best-effort on DeepSeek — the composer intercept is the real protection.
  tripwireEndpoints: ["/chat/completion"],
};
```

---

## 8. Deliverables & MANDATORY live check

- Manifest: `chat.deepseek.com` in `matches` + `web_accessible_resources`.
- `DEEPSEEK_ADAPTER` registered; Gemini/ChatGPT/Grok paths untouched.
- Tripwire: `/chat/completion` via the adapter (confirm `tripwire.js` reads
  `currentAdapter().tripwireEndpoints`).
- `content-main.js`: arm on chat.deepseek.com.
- Turn logging as `provider:"openai"`, `source:"deepseek-web-extension"`.
- Tests: `tests/phase-deepseek.test.ts` mirroring `tests/phase-grok.test.ts` — host scoping (a
  Gemini/ChatGPT/Grok selector never wins on DeepSeek and vice-versa), model-label → slug,
  tripwire fragment aborts on the DeepSeek endpoint *when the body is readable*, and a
  `/log-turn` round trip stores no raw PII as `openai`/`deepseek-web-extension`. Keep
  `npm test`, `npm run test:gemini-e2e`, `npm run test:chatgpt-e2e`, `npm run test:firefox-e2e`
  green. Run `npm run ext:build` so the cross-browser packages aren't stale
  (`tests/phase-cross-browser.test.ts`).
- `CLAUDE.md` ledger row (Phase T — "DeepSeek surface") **including the encrypted-body /
  blind-tripwire limitation**, + a README section.

- **MANDATORY live verification** (because the wire is encrypted and the tripwire can't confirm
  it for you): on real chat.deepseek.com, type a PII prompt (use `scripts/gen-pii-sample.mjs`).
  Confirm (a) exactly ONE `completion` request per send, (b) the redacted text stays in the
  textarea through submit (not reverted by a re-render), (c) DeepSeek's reply refers to the
  **token**, not the raw value, and (d) the turn logs in the Traffic Inspector
  (`http://127.0.0.1:8001`) as a `provider: openai` / `source: deepseek-web-extension` CHAT row
  with only redacted text stored. If the textarea write does not stick, **STOP and report** —
  do not ship (the tripwire can't save you on this surface).

## 9. Acceptance criteria

- A PII prompt on chat.deepseek.com is redacted at the composer (verified per §8), logged as a
  `provider: openai` CHAT row, and **normal messages send and reply normally**.
- Gateway down → send **blocked** (fail closed).
- gemini.google.com, Chrome Gemini Workspace, chatgpt.com, grok.com behavior **unchanged**; all
  suites pass. No new runtime dependency; **no change to `src/` or the redaction logic.**

## 10. Do NOT

- Do not move the gateway fetch out of the background.
- Do not add any runtime dependency.
- Do not change the redaction rules, the intercept/fail-closed logic, or the tripwire detection
  (only ADD DeepSeek's endpoint via the adapter).
- Do not rely on the tripwire on DeepSeek (encrypted body — it's blind here). The composer
  intercept is the protection; verify it lives (§8).
- Do not select the composer on its hashed class; use the id / placeholder.
- Do not let DeepSeek selectors run on other surfaces or vice-versa (hostname-scoped adapter).
- Do not ship if the textarea write doesn't stick. Report it.
