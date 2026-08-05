# LEDGER_HISTORY.md — archived fix notes

> Split out of `CLAUDE.md` on 2026-08-03 to keep the operating manual lean. This is the
> full dated narrative of every phase/fix (Phases G–T and the live-debugging writeups).
> The living gate record (phase tables) and current status stay in `CLAUDE.md` §8.
> Newest notes are near the top, as they were in the ledger.

---


**DeepSeek surface added to the extension (Phase T, 2026-08-03) — built, suite-green,
NOT yet live-verified:** `chat.deepseek.com` is now handled by the same extension. It is
the **first surface that needed ZERO shared-code change** — a new `DEEPSEEK_ADAPTER` in
`extension/src/site-adapter.js`, a manifest host, a tripwire endpoint, and nothing else —
because its composer is a plain `<textarea>` and the textarea write path already existed for
the Workspace composers. Spec: `extension/DEEPSEEK_EXTENSION.md`. Two live findings (probed
2026-08-03, Chrome, signed in) shaped it, and both are worth remembering:
- **Composer = plain `<textarea>`** (probe: `isTextarea:true, anyProseMirror:false,
  anyLexical:false`). So DeepSeek is the ONE surface whose composer selectors deliberately
  target a `<textarea>` and must NOT target a contenteditable (the inverse of the
  ProseMirror surfaces, where a `<textarea>` target ships raw). Selected by a stable id /
  the visible `Message DeepSeek` placeholder — never the probed hashed class, which rotates.
- **The wire is ENCRYPTED, so the tripwire is BLIND here.** A Network-panel search for the
  exact typed text returned **No matches**, and the request list carries
  `create_pow_challenge` + `sha3_wasm` — a WASM proof-of-work; the `completion` body is not
  plaintext. The G4 tripwire scans the outbound body for raw PII, so on DeepSeek it can
  neither confirm the redaction nor abort a raw send. **Redaction still holds** — we scrub the
  textarea BEFORE DeepSeek reads and encrypts it, the same "scrub at the source, not on the
  wire" model as every surface — but the fail-closed net is unavailable, so the **composer
  intercept is the sole protection**. Because a textarea write is reliable (unlike the
  ProseMirror surfaces) that is acceptable, but it makes the **live textarea-write check
  MANDATORY** before trusting the surface: confirm the redacted text stays in the box through
  submit (not reverted by a React re-render) and that DeepSeek's reply references the token,
  not the raw value. The endpoint (`/chat/completion`) is listed anyway — harmless, and covers
  a future plaintext body. This limitation is recorded like the Firefox-Workspace and
  Cursor-queue ones: enforced at the composer, no wire-level backstop.
- Send endpoint confirmed by searching the Network tab for the typed text: the `completion`
  request, `POST https://chat.deepseek.com/api/v0/chat/completion`. Reply is `.ds-markdown`
  inside a `ds-message` wrapper (semantic selectors first, shape capture as fallback). Logs
  `provider:"openai"` + `source:"deepseek-web-extension"` (FROZEN enum untouched).
  `tests/phase-deepseek.test.ts` (5) → suite **188/188**; cross-browser packages rebuilt so
  the staleness guard passes.
- **Uploads PROBED + armed 2026-08-03** (`upload-probe-console.js` on real chat.deepseek.com):
  attach-time (13ms after `change`), page-issued XHR **POST `/api/v0/file/upload_file`** with a
  multipart **FormData** `file` part — the same shape Grok's guard already unpacks, so
  `uploadGuard:true` + `uploadEndpoints:[{host:"deepseek.com",path:"/file/upload_file"}]` was
  the whole change (no shared-code). The probe also exposed a `gator.volces.com/list`
  (ByteDance/Volcano) telemetry flood on attach, excluded by the specific path. **Text
  redaction LIVE-VERIFIED on real chat.deepseek.com** (typed `yesh@gmail.com` → the send bubble
  never showed raw; row logged). **Upload scrub not yet live-confirmed** on DeepSeek (armed,
  suite-green; the earlier raw-file leak was the pre-arm state). NOTE: the CHAT body stays
  encrypted so the tripwire is still blind on the send path — but the UPLOAD body is plain
  FormData, so on uploads the wire backstop DOES work.

**Chrome Workspace panel model-sync FIXED (2026-08-03).** Gemini pushed a Workspace
update (the "File sensitivity: Protected/Internal" banner marks the rollout) that changed
the "Ask Gemini" side-panel composer to a `role="combobox"` `appsElementsRichTextInput`
contenteditable backed by a **controlled model**. Our redacted `execCommand("insertText")`
over a full selection updated the visible DOM (the token showed in the bubble) but the model
treated it as an APPEND and kept the stale raw text, so every PII send shipped raw → the G4
tripwire aborted it (`tripwire.js:284` "raw PII in outgoing XHR body — aborting") → "Something
went wrong." **No leak** (fail-closed), but Sheets/Docs/Gmail/Drive/Chat could not send PII.
gemini.google.com (Quill) and ChatGPT/Grok (ProseMirror) were unaffected — they sync from a
plain insertText. Diagnosed live: a console dump of every editable proved the composer WAS
found (`aria="Ask Gemini"`, class `appsElementsRichTextInputContentEditable`) and DID hold the
redacted token — so the write landed but the model didn't absorb it.
- **Fix (`composer.js` `writeText`, scoped by the `appsElements` class):** replace via
  `execCommand("delete")` THEN `execCommand("insertText")` — a real delete+insert pair the
  controlled model processes as a clean replace. gemini.google.com/ChatGPT/Grok take the
  unchanged single-insertText branch, byte-for-byte.
- **DO NOT dispatch synthetic keystrokes to sync it.** The first attempt fired an extra
  `input` + a synthetic `keyup` after the write; that not only failed to sync PII sends but
  **broke NORMAL (non-PII) Workspace sends too** (the combobox mis-committed) — a real
  regression, reverted. Only genuine editing commands (`delete`/`insertText`) are safe here.
- Live-verified 2026-08-03: PII + non-PII messages send and reply on the Workspace panels
  again. **Drive is slightly flaky** (occasional intermittent failure) — accepted for now.
- This is a Google-side moving target; if it breaks again, re-run the editable-dump diagnostic
  (find what holds the typed text) before changing the write, and never risk normal sends.

**Grok surface added to the extension (Phase S, 2026-07-31) — LIVE-VERIFIED on
real grok.com:** `grok.com` is now redacted by the same extension. This
was the cheapest surface yet and the ledger should say why: Grok's composer is
**Tiptap, which IS ProseMirror**, the same editor ChatGPT uses, so the one
genuinely hard thing — a write that reaches the editor's own document model
rather than just the DOM — was already solved and shipped. No gateway change, no
new machinery, Gemini and ChatGPT paths untouched. Spec: `extension/GROK_EXTENSION.md`.
- **Almost all of it is a new `GROK_ADAPTER` in `extension/src/site-adapter.js`**
  (hostname-keyed selectors/endpoints/log-labels) + a manifest entry. Registered
  as `[CHATGPT, GROK, GEMINI]` — GEMINI stays LAST because it is the fail-safe
  default for an unmapped host.
- **Logs as `provider:"openai"`** (xAI has no member in the FROZEN `Provider`
  enum, so it shares the API-family bucket with ChatGPT/Cursor) with
  `source:"grok-web-extension"` — the source is the ONLY thing distinguishing the
  two surfaces in an audit log, which a test now asserts.
- **ONE change to shared code, and it was necessary, not tidying.** Grok's send
  control is an **unlabeled `button[type="submit"]`** — no aria-label, no
  data-testid, no "Send" text — so the hardcoded click filter in
  `content-main.js` (`aria-label*=Send|Submit`, `data-testid*=send`) did not match
  it and a MOUSE CLICK on send bypassed interception entirely. The filter now
  UNIONs the site's own `liveSendSelector`. Union, not replacement: the generic
  list is what Gemini and ChatGPT have always matched on. It deliberately uses
  `liveSendSelector` and NOT `sendButtonSelectors`, whose Gemini entries end in
  catch-alls like `button:has(mat-icon)` — treating every icon button on a Gemini
  page as a send control would kill unrelated clicks whenever the composer has text.
- The failure this fixed is worth remembering because it is **not** a leak:
  verified by reverting the fix and re-running the e2e — the click sent the RAW
  prompt, the **tripwire aborted it**, and NOTHING went out. So the symptom is "my
  message silently doesn't send when it contains PII" (clean messages send fine),
  which reads like a Grok bug, not a redaction bug.
- **`responseSelectors` is deliberately EMPTY.** Grok marks the assistant turn
  with nothing semantic — rotating Tailwind classes and
  `<span class="animate-gaussian">` word spans — and no candidate could be
  CONFIRMED against the live page. An unverified selector here is worse than
  none: it is tried FIRST, ahead of the shape path, and one that happens to match
  the user's own bubble logs the wrong text as the assistant output. So capture
  falls straight through to `response-capture.js`, the shape-based mechanism
  already proven on Gemini's equally class-name-free Gmail/Drive/Chat panels.
- **Uploads on Grok are PROBED, GUARDED and LIVE-VERIFIED** (`uploadGuard:true`).
  Measured live 2026-07-31, two agreeing runs (`extension/README.md` "Grok uploads"):
  attach at 7197ms → `fetch POST grok.com/http/upload-file-v2/direct` at **7232ms**
  (35ms later; ChatGPT took 259ms) carrying **multipart FormData** with a single
  `file` part, and the message was sent **~24s afterwards**. So Grok is *guardable*
  (plain page fetch, `serviceWorkers: []`), it is **attach-time even harder than
  ChatGPT** — hook `change`/`drop`/`paste`, and attaching then removing before
  sending has already leaked — and the endpoint is `{host:"grok.com",
  path:"/upload-file-v2/"}`, same-origin with none of the region-sharding
  `*.oaiusercontent.com` needed.
- **The attach-time DOM guard needed NO change** — `upload-guard.js` swaps a
  redacted `File` into `input.files`/`DataTransfer` and the page then builds its own
  body from that, so it is body-shape agnostic. All the work was in the wire-level
  backstop, and there were **two** gaps, not one:
  - `isBinaryBody` only recognises a `Blob`, so multipart was invisible. Replaced
    with `uploadBlobsOf(body)` (`upload-core.js`) which returns the file-bearing
    parts of a raw Blob **or** a `FormData`. It returns **all** file parts, not the
    first — PII in the second file of a multi-file attach would otherwise sail
    past — and yields `[]` rather than throwing on any unexpected shape, since it
    runs inside the fetch/XHR wrapper on every request.
  - **The backstop was wired into `XHR.send` ONLY.** ChatGPT PUTs over XHR, so
    `fetch` never needed it; Grok POSTs with `fetch`, so whatever the body shape
    Grok had **no wire-level net at all**. `tripwire.js` now has a fetch-side
    branch (cheaper than XHR's: fetch already returns a promise, so the async read
    is just awaited before delegating). The XHR branch also goes through
    `uploadBlobsOf`, so a surface that switches to multipart stays covered.
- `pageReadTheFile:false`, so Grok does not re-encode the file — the fat
  `_data/v1/a/t/` JSON bodies are analytics, not a second copy.
- **e2e false-pass caught while writing the tests:** `fake-grok.html` first posted
  its upload to a RELATIVE path, so `isUploadUrl` resolved it against the harness's
  `127.0.0.1` origin and Grok's `{host:"grok.com"}` never matched — the bypass test
  read as "no abort" and **passed for the wrong reason**. The fixture now posts to
  the absolute `https://grok.com/http/upload-file-v2/direct` with Playwright
  routing the host locally, exactly as the ChatGPT harness does with
  `*.oaiusercontent.com`. Same lesson as the probe's own ranking bug: a test that
  can't reach the code path it names is worse than no test.
- Playwright gotcha on this machine: `chrome-headless-shell-mac-x64` is looked for
  on an arm64 host (macOS 26 is newer than Playwright's platform table), so the e2e
  needs `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=mac15-arm64` **and** to run outside the
  sandbox (Chromium SIGSEGVs inside it with `kill EPERM`).
- **LIVE-VERIFIED on real grok.com (Chrome, signed in, 2026-07-31), all three paths,
  and this is the STRONGEST upload verification in the project so far** — on ChatGPT
  the model only *summarised* what it received, whereas Grok reproduced the files
  verbatim:
  - *Text scrub:* `pii-sample.txt` attached → Grok printed the whole file back and
    **all 14 default rules had fired** (EMAIL, PHONE_US, PHONE_IN, SSN, CREDIT_CARD,
    PAN_IN, AADHAAR, IPV4, IPV6, JWT, API_KEY, BEARER_TOKEN, CONN_STRING,
    PRIVATE_KEY), with its own verdict "All the sensitive values appear to be
    redacted."
  - *Office scrub:* `upload-office-test.docx` → Grok printed the document content
    with the email, SSN and card redacted and the clean paragraph unchanged. Those
    three values are **split across Word runs** in the fixture, so this proves the
    per-paragraph concatenation on the real path AND that **xAI's document parser
    accepted our REBUILT zip archive** — a second independent consumer after
    OpenAI's, which is a stronger check on `zip.js` than `unzip -t`.
  - *Refuse:* a PDF could not be attached at all — intended (`binary-extension`),
    not a bug.
- **Diagnostic worth remembering:** immediately after the source edits, every send
  AND upload failed with "PII gateway unreachable — message blocked (fail-closed)"
  while the gateway was healthy on 8001 and `/redact` answered a
  `chrome-extension://` origin with correct CORS. Cause: Chrome keeps running the
  **old service worker** until the extension is reloaded, so the page→SW hop dies
  and everything fails closed. `chrome://extensions` → Reload → **new tab** fixed
  it. The page console only ever shows the generic fail-closed line; the real error
  is in the SW's own console.
- **DRAG-AND-DROP now has automated coverage, and it is the FIRST anywhere** — both
  upload harnesses drove the picker only, and the path had been exercised live
  exactly once (Firefox/ChatGPT). It is not a variation of the picker: the guard
  re-fires a constructed `DragEvent` instead of writing `input.files`, and that
  event must BUBBLE back to the page's own handler to be honoured, so a re-fire the
  page never receives would look identical to a successful block. 10 checks in
  `run-grok.mts` (grok e2e **46/46**); `fake-grok.html` gained a drop zone whose
  listener is on the zone (bubble phase) so the guard's document-level capture
  listener necessarily runs first, and both entry points share ONE uploader — a
  second entry into the same leak, not a second leak.
- **The drop tests were mutation-checked, and the result changed what we know about
  the layering.** Neutering only the drop listener failed 6 of the 10 (so they are
  load-bearing, not decoration) — but four still PASSED, because the **tripwire
  backstop independently aborted the raw multipart upload** (`blocked` came back as
  `tripwire-upload` instead of `upload-blocked`). Defense-in-depth genuinely holds
  for a *text* file: with the DOM guard broken, raw PII still never reached the
  wire. **The load-bearing caveat: that only worked because the fake PDF contained
  a scannable email.** A real binary PDF reads as garbage no rule matches, so the
  tripwire cannot see it and **the attach-time DOM guard is the ONLY thing that
  stops unscannable formats** — exactly as the Phase Q note says. Do not read
  "tripwire caught it anyway" as the drop guard being redundant.
- **DRAG-AND-DROP LIVE-VERIFIED on real grok.com in Chrome 2026-07-31 — the first
  live drop verification on CHROME on any surface** (ChatGPT's drop had only ever
  been exercised on Firefox). `pii-sample.txt` dragged in from Finder → Grok listed
  the file back with all 14 types tokenised ("Everything sensitive is still
  redacted"). This is the one thing the new harness coverage could NOT prove: the
  e2e constructs its `DragEvent` in page JS, so only a real OS drag shows that the
  guard's swallow-and-re-fire survives a genuinely trusted drop and that the
  synthetic re-drop reaches the page's own handler on the real DOM.
- macOS gotcha when doing this by hand: a **fullscreen** browser window lives in its
  own Space, so Finder opens in a different one and there is no moment where both
  are on screen — the drag has nowhere to land and it reads as a broken guard. Exit
  fullscreen (`Ctrl+Cmd+F`) and the Finder window floats above it in the same Space.
- **MIXED MULTI-FILE ATTACH live-verified on grok.com 2026-07-31** (a `.txt` and a
  `.docx` in one attach, both arrived redacted) — and it exercises a combination no
  single-file case reaches, so it is now covered in the harness too (grok e2e
  **58/58**, 10 new checks). The two kinds take **different branches of the guard's
  reassembly**: an Office scrub returns a whole rebuilt `File` (`decision.file`),
  while a text scrub returns replacement *text* that must be wrapped back into a
  `File`. Both run in one `settle()` pass, so a mix-up would put the archive's bytes
  under the text file's name or wrap the zip as text and corrupt it. Also locks in
  order/filename preservation and the **all-or-nothing** rule (one unscannable file
  blocks the whole batch — not even its clean sibling uploads, because a partial
  success where the user believes the PDF was sent is worse than a refusal).
- Writing that test surfaced a would-be **false pass worth remembering**: the
  uploaded `.docx` is DEFLATED, so decoding the multipart body as text and grepping
  it proves nothing about the XML inside. The check now slices the archive out of
  the body and `readZip`s it, asserting the token IS in `word/document.xml` and the
  clean paragraph is verbatim. A string-level assertion would have passed even if
  the archive had been shipped unscrubbed.
- Still untried on Grok: a document straight out of Word/Google Docs (the `.docx`
  fixtures are hand-built), and a *dropped* `.docx` (the live drop used a text file;
  Office is covered via the picker).
- **Probe procedure is written down** (`extension/README.md` "Probing a new
  surface's file uploads") and `upload-probe-console.js` reports a `summary`
  answering the four design questions: reachable from page world at all,
  attach-time or send-time, which host+path becomes `uploadEndpoints`, and whether
  the body shape is one the guard handles (`needsNewGuardWork`).
- **Candidates are RANKED, and Grok is why.** Its analytics send `Blob`s to
  `/api/log_metric` and 12–26 KB JSON to `/_data/v1/a/t/`, so a shape-only filter
  ranked a beacon **5.8s BEFORE the attach** as "the first upload" — a NEGATIVE
  attach→upload gap, and an attach-vs-send verdict that was right only by luck.
  Only "strong" candidates (after the attach; multipart part naming the file, or a
  size match whose tolerance depends on body kind — a raw Blob is the file
  verbatim, a string may expand ~1.34x for base64) drive conclusions; the rest are
  still listed as `weakCandidates`. An `inconclusive` flag covers weak-only,
  because a bare `reachableFromPage:false` would read as "nothing to guard".
- The probe's own analysis is self-checked headlessly
  (`npm run probe:upload-selfcheck`, **33 checks**) by replaying the known-correct
  ChatGPT **and** Grok traces — it must keep reproducing
  `{host:"oaiusercontent.com", path:"/files/"}` + "leaves at attach time", the
  findings the whole upload guard rests on. That check has caught **three** real
  bugs: the `file-selected` row counted as its own upload request (zeroing the
  attach→upload delta), an API version suffix (`upload-file-v2`) treated as a
  per-request id (truncating Grok's endpoint to a useless host-wide `/http/`), and
  telemetry outranking the real upload.
- **Gemini uploads remain entirely unprobed** — same procedure applies there.
- Tripwire fragment `"/rest/app-chat/conversations/"` — the shared PREFIX covers
  both the follow-up `/{id}/load-responses` and the new-chat `/new` paths and is
  robust to the conversation id. Grok's auth/rate-limit/statsig traffic is not
  inspected (the false-positive class that once forced the tripwire off entirely).
- `tests/phase-grok.test.ts` (5) locks in host scoping, the never-target-a-
  `<textarea>` rule, tier-label → slug, the tripwire abort on Grok's endpoint, a
  real `/log-turn` round trip storing no raw PII, and that **x.com/twitter.com
  Grok is NOT claimed** (different DOM, deliberately out of scope). Note the
  composer lists legitimately share the generic `div.ProseMirror` selector with
  ChatGPT — same editor, and each list only ever runs on its own host — so the
  disjointness assertion allows exactly that one and nothing else.
- `npm run test:grok-e2e` (21) drives the real content script against
  `fake-grok.html`, whose composer follows only genuine editing, whose reply is
  class-name-free streaming word spans with suggestion chips appended after it,
  and which plants a `div.ql-editor` Gemini decoy that must never win.
- **LIVE-VERIFIED on real grok.com in Chrome 2026-07-31** (user-run, unpacked
  extension, signed in), and this run is as strong as the Firefox/ChatGPT one:
  the full `scripts/gen-pii-sample.mjs` sample was sent and **all 14 default
  rules fired in one turn** (EMAIL, PHONE_US, PHONE_IN, SSN, CREDIT_CARD, PAN_IN,
  AADHAAR, IPV4, IPV6, JWT, API_KEY, BEARER_TOKEN, CONN_STRING, PRIVATE_KEY).
  Corroborating evidence: **Grok's own reply said "All the sensitive fields in
  your message were already redacted before they reached me, so there's nothing
  for me to see or store"** — the model confirming the raw values never left the
  browser. An earlier single-email turn was checked on the WIRE, which is the
  acceptance criterion (a DOM check gives a FALSE PASS when the editor model is
  desynced — exactly how the Firefox Workspace bug survived):
  DevTools cross-request search found `"message":"…reply to
  [REDACTED_PII_EMAIL]","se[nder]"` on
  `/rest/app-chat/conversations/{id}/load-responses`, and a search for the raw
  address across **all 159 captured requests** returned **no matches**.
- **The 14-rule turn was sent by MOUSE-CLICKING the send arrow**, so the
  shared-code click-filter fix above is live-verified on the path it exists for —
  not just covered by the e2e.
- Search-technique note for the next surface: **`load-responses` is used for BOTH
  the message POST and a plain history fetch** (the latter's payload is just
  `{"responseIds":[…]}`). Clicking a row by name can therefore land on the wrong
  instance and look like the endpoint is wrong. Use the Network panel's
  cross-request SEARCH for a distinctive word of the prompt instead of guessing
  the row — that is also how the endpoint was originally found.
- Suite **178/178**; grok e2e 21/21; chatgpt e2e 36/36; gemini e2e 15/15;
  response e2e 8/8; firefox e2e 12/12.
- Still untried on Grok: **Firefox** (Chrome only so far), **drag-and-drop**
  uploads, and the `modelSelectors` guesses (a miss just logs `grok`). File
  uploads via the picker are now guarded and live-verified — see S-Upload.

**ChatGPT surface added to the extension (Phase P, 2026-07-30):** `chatgpt.com` is now
redacted by the same extension, with **zero gateway change** and the Gemini path
functionally untouched. Everything site-specific moved into a new hostname-keyed
`extension/src/site-adapter.js` (`GEMINI_ADAPTER` / `CHATGPT_ADAPTER`: composer, send,
stop, model, response selectors + tripwire endpoint fragments + the `/log-turn`
provider/source); `composer.js`, `content-main.js` and `tripwire.js` became
site-agnostic and read the adapter. Scoping by host is a security property, not tidiness
— a stray generic match on the wrong element is what leaked raw PII on Sheets
(2026-07-21), and an unknown host still falls back to the Gemini adapter so nothing
silently disarms. ChatGPT logs as **`provider: "openai"`** (its API family, already a
valid `Provider`, so the FROZEN enum is untouched) with `source: "chatgpt-web-extension"`.
Spec: `extension/CHATGPT_EXTENSION.md`; findings: `extension/CHATGPT_COVERAGE.md`.
- **The one real risk was proven on the wire BEFORE any code was written.** ChatGPT's
 composer is **ProseMirror**, which builds the outgoing request from its own document
 model, so a write that only changes the visible DOM ships the RAW prompt — exactly the
 failure mode Firefox's Workspace panel still has. `npm run probe:chatgpt -- --send`
 typed a real prompt on the live site, applied one write strategy, and read the
 `/backend-api/conversation` body: the hidden companion `textarea` → **raw** (it is a
 decoy; the request is not built from it), a synthetic `paste` → **appended** the token
 beside the raw text (worse than nothing), `beforeinput` → ignored, and the **existing
 Gemini `execCommand("insertText")` write → token only, no raw**. So no new write code
 shipped, and the spec's assumption that ProseMirror needs a paste dance is wrong.
- **`--load-extension` is silently dead in branded Chrome 137+.** A live acceptance run
 showed raw PII on the wire and looked like a redaction failure; the extension had in
 fact never loaded. The probe now uses Playwright's Chromium (`channel: "chromium"`) for
 extension runs and **hard-fails unless a `chrome-extension://` service worker exists**,
 so this can't be misread again. That build needs its own login (per-build Keychain
 cookie encryption), which is why live verification is done manually in the user's own
 Chrome — `chrome://extensions` → **Reload** (a manifest change needs it) → **new** tab.
- Manifest gets a **separate content-script entry** for ChatGPT with `all_frames: false`
 (single top-level SPA, no cross-origin composer iframe like Gmail's), leaving the Gemini
 entry byte-identical. Reply capture uses ChatGPT's semantic
 `[data-message-author-role="assistant"]`, so the shape-based fallback isn't needed.
- `tests/phase-chatgpt.test.ts` (8) locks in host scoping, selector/endpoint disjointness,
 the never-target-a-`<textarea>` rule (note the real composer's *id* is `prompt-textarea`
 while being a `<div>`), the tripwire abort on ChatGPT's endpoint, model-label → slug, and
 a real `/log-turn` round trip storing no raw PII. `npm run test:chatgpt-e2e` (17) drives
 the real content script against `fake-chatgpt.html`, whose composer follows only genuine
 editing (a `textContent` write ships stale text) and which plants a `div.ql-editor` Gemini
 decoy that must never win; it asserts token-on-wire, one send, one `/redact`, the `openai`
 row with model + reply, gateway-down ⇒ blocked, and desynced-editor ⇒ tripwire abort.
- **LIVE-VERIFIED on real chatgpt.com in Chrome 2026-07-30** (user-run, unpacked extension).
- Suite **162/162**; chatgpt e2e 17/17; gemini e2e 15/15; response e2e 8/8; firefox e2e 12/12.

**ChatGPT on Firefox — works; the failure was a STALE GENERATED PACKAGE (2026-07-30):**
Reported as "perfect on Chrome, broken on Firefox". Cause was **not** code:
`extension/build/firefox` is what you load into Firefox and **nothing regenerates it**,
so it was still the pre-ChatGPT package — no `chatgpt.com` in its manifest and no
`site-adapter.js`. The add-on therefore **never injected on that host**, which is worse
than an ordinary bug: with no content script there is neither an interceptor nor a
tripwire, so the page was **unprotected** (not fail-closed) and anything typed there went
out raw. Fix is `npm run ext:build` + reload the add-on.
- **Now guarded in `npm test`:** `tests/phase-cross-browser.test.ts` fails if an on-disk
 generated package differs from a freshly built one — manifest **and** the contents of
 every file it names (the manifest can match while a copied module is stale or missing,
 which is exactly what happened). Skips when nothing has been built, so CI is unaffected.
 It immediately caught a stale **Safari** package too. Also extended the shim-order and
 file-presence assertions to loop over ALL manifest entries, since a new surface adds one.
- **Both Firefox-specific risks were then cleared against the real page, no login needed
 and nothing sent to OpenAI.** (a) CSP: Gecko applies a page's CSP to a content-script
 -inserted `<script>`, and a refusal would mean no interceptor AND no tripwire —
 `npm run probe:firefox-csp -- https://chatgpt.com/` reports `tripwireInstalled:true`.
 (b) Model sync: new `npm run probe:firefox-chatgpt` proves Gecko syncs the redacted
 write into **ProseMirror**'s document model. **So the Firefox Workspace-panel limitation
 does NOT extend to chatgpt.com.**
- That sync probe is deliberately not a DOM check — a DOM check gives a FALSE PASS here,
 which is how the Workspace bug survived. ProseMirror re-renders from its own model, so
 the probe types raw text with **trusted** Marionette keys, applies `writeText`, then
 sends **one more trusted keystroke**: a stale model re-renders and wipes the token, a
 synced model keeps it. It keeps it.
- **LIVE-VERIFIED on real chatgpt.com in Firefox 153.0.1 2026-07-30** (temporary add-on
 from `extension/build/firefox`), and this run is STRONGER than the Chrome one: the full
 `scripts/gen-pii-sample.mjs` sample was sent and **all 14 default rules fired in one
 turn** (EMAIL, PHONE_US, PHONE_IN, SSN, CREDIT_CARD, PAN_IN, AADHAAR, IPV4, IPV6, JWT,
 API_KEY, BEARER_TOKEN, CONN_STRING, PRIVATE_KEY) — stored prompt all tokens, an
 independent raw-PII scan of the stored row found nothing, reply captured, logged as
 `openai`/`chatgpt` /`chatgpt-web-extension`. A plain non-PII turn also sent normally.
 Corroborating evidence from an earlier turn: ChatGPT's own reply said the address "has
 been redacted as `[REDACTED_PII_EMAIL]`" — the model itself confirming the raw value
 never left the browser.
- Firefox e2e flake to remember: a leftover harness Firefox holds the debugger/Marionette
 port and the next run dies with `ECONNREFUSED`. `pkill -f gemini-redact-ff` first — and
 note that pkill run under a sandbox can silently do nothing.
- Auditing the ring buffer, remember `entries` is NOT in chronological order — sort by
 `timestamp` before taking "the latest", or a present row looks missing. Also note a
 `\[REDACTED_PII_[A-Z_]+\]` pattern silently misses `IPV4`/`IPV6` (digits).

**File-upload guard — Phase Q (2026-07-30, ChatGPT only, LIVE-VERIFIED):**
Attaching a file bypassed everything: it never passes through the composer, and the
upload does not touch the conversation endpoint the tripwire inspects. **Probed first**
(`extension/test/e2e/upload-probe-console.js`, metadata only — never file content) on a
real signed-in chatgpt.com session, and the probe changed the design:

```
18348ms  file-selected  INPUT.CHANGE   pii-sample.txt  652 B  text/plain
18607ms  xhr PUT  https://sdmntprcentralindia.oaiusercontent.com/files/<id>/raw   body: File
37329ms  fetch POST  /backend-api/f/conversation            ← 19 SECONDS LATER
```

- `serviceWorkers: []` and the body is a page-issued XHR — so it **is** reachable.
- **The bytes leave at ATTACH time, ~19s before the message is sent.** Guarding the
  submit would be far too late, and **attaching a file then removing it before sending
  already leaked it**. Hence the guard hooks `change`/`drop`/`paste`, not submit.
- The upload host is **region-specific** (`sdmntprcentralindia…`), so it is matched as a
  domain SUFFIX (`oaiusercontent.com` + `/files/`), never hard-coded.

Built as attach-time **kill-and-re-fire** (the composer's proven pattern): swallow the
event in the capture phase, **clear the input** (ChatGPT reads `input.files`, so leaving
the raw File there is not safe), scrub via `/redact`, re-fire with a redacted `File`.
`src/upload-core.js` is the pure decision core, `src/upload-guard.js` the DOM glue,
`src/tripwire.js` gained a backstop that aborts a raw-PII upload PUT.
- **Unscannable formats are BLOCKED** (decided with the user): PDF/DOCX/XLSX/images
  cannot be parsed without a dependency, so they are refused rather than uploaded
  unscanned. A **pasted screenshot is therefore blocked** — intended, not a bug.
- A **binary extension beats a text MIME type** (`payroll.pdf` as `text/plain` is
  blocked): trusting caller-supplied MIME would run a PDF through a text scan, "pass"
  it, and upload it raw. A clean file uploads **unchanged**; a multi-file attach is
  all-or-nothing.
- The backstop **defers `send()`** across an async Blob read (the one change to the
  security-critical wrapper). Read failure passes through — it is a backstop, and a
  binary body reads as garbage no rule matches, so unscannable formats can only be
  stopped at attach time.
- **Gemini/Workspace uploads stay UNGUARDED** (`uploadGuard:false`): same gap, but
  unprobed, and arming an untested guard on a live-verified surface risks breaking
  attachments to close a documented gap. Probe them the same way first.
- `tests/phase-upload.test.ts` (4) → suite **166/166**; ChatGPT e2e **31/31** (14 new).
- **LIVE-VERIFIED on real chatgpt.com (Chrome, signed in, 2026-07-30) — both halves:**
  - *Scrub:* the 14-type `pii-sample.txt` attached → ChatGPT itself reported the file it
    received "contains placeholder tokens indicating that sensitive information (such as
    email, phone numbers, SSN, credit card, PAN, Aadhaar, API keys, etc.) has been
    redacted". Exactly **one** upload per attach (one preflight + one xhr — no
    raw-then-redacted double send), and DevTools' **Initiator column read
    `tripwire.js:209`**, proving the PUT was issued through our deferred-send wrapper
    rather than around it.
  - *Refuse:* `upload-block-test.pdf` (fake email + SSN inside, so the block must come
    from the FORMAT) → **no upload request at all**, no attachment chip, console
    `File attachment blocked … upload-block-test.pdf: binary-extension`.
  Full writeup: `extension/CHATGPT_COVERAGE.md` §6.

**Office-file scrubbing — Phase R (2026-07-30, live-verification pending):** Phase Q
blocked everything it couldn't read as text, which is exactly the set of files people
attach at work. DOCX/XLSX/PPTX are the tractable case — **ZIP archives of XML** — and
`DecompressionStream`/`CompressionStream` are browser built-ins, so read → redact →
rewrite needs **no dependency**. Unlike a PDF this is a real scrub: a work document
with a client's address is **cleaned and sent**, not refused. `src/zip.js` (central
directory + CRC-32 + deflate), `src/ooxml.js` (text parts, paragraph extract/rebuild).
- **Word SPLITS words across runs** — `<w:t>dana@</w:t><w:t>corp.example</w:t>` — so
  per-run scanning finds NOTHING (same class as PII split across SSE chunks). Text is
  concatenated **per paragraph** before scanning; the e2e proves that exact case.
- Only **changed** paragraphs are rewritten (untouched ones keep their runs byte for
  byte); a modified paragraph collapses into its first run, so mid-sentence styling
  can be lost — accepted against leaking or refusing.
- Paragraphs join with **NUL** for one gateway round trip: not a legal XML character,
  so the split back is unambiguous and no rule matches across it.
- **A rebuild that doesn't line up paragraph-for-paragraph throws → BLOCK.** Legacy
  binary `.doc/.xls/.ppt` stay blocked; PDFs stay blocked (extraction would only ever
  buy detection — rewriting a PDF means a real PDF writer, out of scope).
- **The escape hatch was UNREACHABLE for its first day — found 2026-07-31 when a
  user asked for exactly this behavior.** `upload-guard.js` implemented
  `policy:"warn"` and `content-main.js` read `CONFIG.uploadPolicy`, but the value
  has to cross the isolated→MAIN bridge and `content-bridge.js CONFIG_KEYS` did not
  list it, so storage was read, the key was dropped, and MAIN silently kept
  `"block"`. **Nothing caught it because every test sets config by dispatching the
  MAIN-world event directly, bypassing the bridge** — the same blind spot shape as
  the stale-package bug. `uploadGuard` was missing too (no kill switch). Fixed by
  adding both, guarded by `tests/phase-upload.test.ts` "the uploadPolicy escape
  hatch is actually REACHABLE from storage", which asserts every `CONFIG.<key>` that
  `content-main.js` reads is relayed. **Lesson for any new config key: add it to
  `CONFIG_KEYS` or it is dead config.** Suite 183/183.
- To enable: `chrome.storage.local.set({ uploadPolicy: "warn" })` from the
  extension's service-worker console (or push it via `storage.managed` for a fleet —
  managed wins over local). Takes effect on the next page load; `onChanged` also
  re-publishes.
- **The `warn` behavior ALSO had zero coverage** — no unit test, no e2e — so after
  making the key reachable the path behind it was still unproven. Now covered by 9
  checks in the Grok e2e (**67/67**): a PDF `block` would refuse is uploaded, no
  "blocked" message is shown, an `unchecked` audit row IS filed naming the file, the
  row is attributed to the surface, and it carries **no file content**. Plus the
  scoping edge: with `warn` set, a readable file whose gateway call FAILS still
  blocks — otherwise "warn" would quietly degrade into "send everything raw whenever
  the gateway hiccups", the opposite of the intent.
- Honest limit of a `warn` row: because the file cannot be read, `piiDetected` is
  never set, so it does **not** trip the `unchecked`+PII "confirmed leak" alert built
  for Cursor. The row means **unknown**, not clean and not confirmed-leaked.
- **Escape hatch:** `uploadPolicy:"warn"` (storage) uploads an unreadable file
  and files an `unchecked` audit row instead of refusing — reusing the Cursor
  bypass-audit flag and pill. Default stays `block`. Scoped to `upload-unscannable`:
  a gateway failure or a misaligned rebuild still blocks under either policy. The row
  is filed **at attach time** because the upload precedes the turn by ~19s.
- `tests/phase-ooxml.test.ts` (7, incl. validating the rebuilt archive with the system
  `unzip -t`) → suite **173/173**; ChatGPT e2e **36/36**.
- **LIVE-VERIFIED on real chatgpt.com (2026-07-30)** with
  `scripts/gen-office-sample.mjs` (email + SSN + card, each SPLIT ACROSS RUNS):
  ChatGPT reported the document it received "includes redacted placeholders for
  sensitive information (such as an email, SSN, and credit card), while a
  non-sensitive paragraph remains unchanged". Two things this proves beyond the
  suite: the per-paragraph concatenation catches split values on the real path, and
  **OpenAI's own document parser accepted our REBUILT archive** — a stronger check on
  `zip.js` than `unzip -t`, since a real consumer read it end to end.
- Still untried: a document straight out of Word/Google Docs (themes, styles, many
  more parts). The fixtures are hand-built, so that is the likeliest surprise.
- **FIREFOX: measured, not assumed** (`npm run probe:firefox-upload` — real headless
  Firefox on a `file://` page, no login/network). `deflate-raw` ✅ (so the whole
  zip/Office scrub works), `File.text()/arrayBuffer()` ✅, `DataTransfer` +
  `input.files` setter ✅ (picker re-fire), `DragEvent` with a constructed
  `dataTransfer` ✅ (drag-and-drop re-fire). **Only `ClipboardEvent` with
  `clipboardData` is ❌** — Gecko drops it, so **pasting a FILE on Firefox always
  blocks** ("use the + button"), even a clean text file. Fail-closed, no leak;
  pasting text is unaffected. Probe gotchas worth keeping: RDP's tab list does not
  expose `about:blank`, and each Marionette `executeScript` gets its OWN sandbox
  (so `window`-stashed results polled from a second call read back empty — it must
  be one `ExecuteAsyncScript`).
- **Firefox LIVE-VERIFIED on real chatgpt.com 2026-07-30, all four paths:** picker
  scrubs a text file, **drag-and-drop** scrubs one, the `.docx` arrives with
  placeholders, and pasting a file blocks gracefully with the "+ button" message.
  **Drag-and-drop had NO coverage anywhere before this** (the e2e drives the picker
  only), so Firefox is the only place that path has been exercised — **Chrome's drop
  path remains unproven**.

**Cross-browser port of the extension — Firefox ✅, Safari ⚠️ unverified (2026-07-30):** The
Chrome MV3 extension now also builds for Firefox and Safari with the browser-agnostic core
**unchanged** — only `manifest.json`, `background.js`, `content-bridge.js`, `loader.js` plus a
new `src/browser-api.js` shim (`chrome ?? browser`, zero-dep, NOT `webextension-polyfill`).
`scripts/build-extension.mjs` generates `extension/build/{firefox,safari}` from the Chrome
manifest (single source of truth for hosts/permissions); `extension/` stays the Chrome package.
**No gateway change was needed** — `isExtensionOrigin` (`src/server.ts`) already matches
`moz-extension://` and `safari-web-extension://` by SCHEME, which also covers Safari rotating
its extension GUID every launch.
- **The shim must resolve `chrome` BEFORE `browser`.** Both engines expose both namespaces, but
  `browser.*` is promise-only: it rejects the trailing callbacks this code passes everywhere and
  ignores `return true` for a deferred `sendResponse`. Flipping the order fails **closed** (every
  send blocked) — safe but unusable. `tests/phase-cross-browser.test.ts` locks the order in.
- **Firefox: no MV3 service worker** (bug 1573659) → generated manifest uses `background.scripts`
  + `type:"module"`. Firefox 153 loads it with zero manifest warnings, background `RUNNING`.
- **Firefox needed `cloneInto`.** Gecko isolates the content-script compartment, so a
  `CustomEvent` `detail` built in `content-bridge.js` is opaque to MAIN ("Permission denied to
  access property") — MAIN never reads the redaction result and every send blocks. The bridge
  clones with `cloneInto(detail, window)`, capability-tested so Chrome/Safari are unaffected.
  Also fixed a startup race by re-publishing the config/learned-composer events (MAIN's module
  injection can land after the single original dispatch).
- **The biggest port risk — page CSP killing the MAIN-world injection — is clear.** Gecko applies
  a page's CSP to content-script-inserted script tags (bugs 1267027/1591983) and Gemini serves
  `nonce` + `strict-dynamic`; a refusal would mean no interceptor AND no tripwire (silent leak).
  Verified against the real page with `npm run probe:firefox-csp` (no Google login needed): module
  loads, tripwire installs. `loader.js` now also escalates a refused load as `blocked`.
- **Firefox e2e is zero-dep and real:** `npm run test:firefox-e2e` (12/12) installs the built
  add-on over Firefox's remote debugging protocol (`firefox-rdp.mts` — replaces `web-ext`) and
  types **trusted** keystrokes over Marionette (`firefox-marionette.mts`), because the loop guard
  ignores `isTrusted:false`. Covers redacted-token-on-the-wire, zero raw PII, exactly one send,
  and gateway-down → blocked. **Live signed-in send on real gemini.google.com — DONE
  2026-07-30:** prompt redacted on the wire + real replies captured for 3 turns, identical
  to Chrome. (That test also surfaced the privacy-footer capture bug now fixed for all
  browsers — `looksLikeBoilerplate`, `7ff1869`.)
- **Safari could NOT be built or run here** — `xcrun safari-web-extension-converter` ships only
  with full Xcode; this machine has Command Line Tools only. So the loopback question is OPEN and
  every Safari step in `extension/README.md` is marked unverified. Handled in advance: Safari's
  MV3 background *service worker* enforces CORS on extension fetches (Apple DTS 654839), so the
  Safari manifest declares **only** `background.scripts`; `storage.managed` absence degrades to
  `local`. Prerequisites documented: App Sandbox → Outgoing Connections (Client), plus macOS ≥ 15
  Privacy → Local Network → Safari. If Safari does block loopback, the extension blocks sends —
  **no silent leak** — and that stays the honest outcome (do not move the fetch into the page).
- Suite **153/153**; Gemini e2e 15/15; response e2e 8/8; Firefox e2e 12/12.

**Assistant output missing for 4 of 7 browser surfaces — FIXED (2026-07-29):** The
Inspector showed the user prompt for every Gemini surface but the assistant output only for
Gemini web, Docs, Sheets and Slides; Gmail, Drive and Chat read "(none)". Cause was already
documented (§5.6 of `extension/WORKSPACE_COVERAGE.md`): those panels are the OBFUSCATED
builds whose class names rotate every Google deploy, so `RESPONSE_SELECTORS` can't match,
and the earlier `last [role="listitem"]` fallback had been reverted for grabbing a
**suggestion chip** instead of the reply. Fixed by capturing the reply by **shape**, anchored
on the text we just submitted: `extension/src/response-capture.js` finds the **deepest**
element containing the sent text (the user's bubble — depth, not text length: on a first turn
the whole conversation container holds exactly the prompt, and anchoring there puts the reply
*inside* the anchor where it is excluded — real bug, caught by the new tests) and tracks
blocks that **follow** it; `extension/src/response-finder.js` (pure) ranks them on behavior
rather than class names — a reply **streams** (text grows across samples) and is
non-interactive, whereas chips arrive fully formed as buttons. Blocks preceding the user's
message are disqualified outright, so a previous turn's reply can never be mispaired. The old
invariant is kept as the tie-breaker: nothing clears the bar ⇒ log a **blank** response.
Semantic selectors still run first, so the four working surfaces are untouched.
- Anchor lookup has a **text-node fast path** (`createTreeWalker`) because concatenating
  `textContent` for every element on a DOM the size of Gmail's would jank the page mid-stream;
  the element scan remains the fallback and both paths are tested.
- `CONFIG.settleMs`/`CONFIG.turnTimeoutMs` are now configurable (were hardcoded 2500/30000)
  so the e2e can exercise the "no reply ever arrives" path without a 30s wait.
- `tests/phase-gemini-response.test.ts` (8 tests: scorer trio + DOM walk against a minimal
  zero-dep DOM shim, both anchor strategies) → suite **141/141**. Browser-gated:
  `npm run test:gemini-response-e2e` (`extension/test/e2e/run-response.mts` +
  `fake-panel.html` reproduce all three panel shapes; needs `npx playwright install chromium`,
  **not yet run here — chromium binary unavailable in this environment**). Live per-surface
  confirmation in the Inspector still pending for Gmail/Drive/Chat.

**DOM-change resilience (2026-07-22, Layers 1 + 1.5 + 2):** `findComposer` (`extension/src/composer.js`) now tries a fast-path of **Gemini-SPECIFIC** selectors only (`div.ql-editor`, `rich-textarea .ql-editor`, Workspace `aria*="Ask Gemini"`) — the generic catch-alls (`role=textbox`, bare `textarea`) were **removed from the fast-path** because a blind generic match can return the wrong sane element (a search box / doc canvas) before stronger signals run (this leaked raw PII in the Layer-1.5 e2e until fixed). When the fast-path misses, all editable candidates go through `chooseComposer` (`extension/src/composer-learn.js`): **focus** (the box the user is typing in — decisive when several big boxes compete, "Case B") > **learned fingerprint** (persisted from a prior focused submit, so a later load recalls the composer after a redesign) > **heuristic shape** (`composer-finder.js`: size ≥ `MIN_COMPOSER_AREA`, prompt-like label, near an enabled send button). One path covers gemini.google.com + every Workspace app. The learned fingerprint is shape metadata only (tag/role/aria/stable class tokens — **never PII**), persisted via the isolated bridge to `chrome.storage.local` (`learnedComposer`) and restored into MAIN on load. Security is unchanged: an unfindable composer still fails **closed** (`content-main.js`) and the G4 tripwire still aborts raw PII on the wire — availability/UX win, not a security change. **Layer 2** is a detect-only canary (`scripts/selector-watch.mjs`, `npm run watch:selectors`): opens the real surfaces in a pre-logged-in Chrome profile (`--hold` keeps the browser open to sign in / open Workspace panels, then Enter to probe), reports whether the composer is findable, writes `~/.secure-llm-gateway/selector-watch-report.json`, exits non-zero on a hard break (gemini composer missing, or raw PII on the wire with `WATCH_SEND=1`). `--self-check` validates the probe headlessly. **Live-verified 2026-07-22: gemini composerFound=true on real gemini.google.com.** **Layer 3 (blind offline auto-patch of selectors) deliberately NOT built** — Layer 1.5 is the safe realization of "auto-identify after a Google change": it learns by the focus-at-submit signal (evidence, no leak) rather than guessing + persisting a selector.

**Gemini-web extension (Phase G, started 2026-07-20):** New workstream under
`extension/` (sibling to `src/`, not coupled to the gateway module graph — it
only calls `POST /redact` over loopback, same pattern as the Cursor hooks).
Design + phase gates: `scripts/gemini_imp.md` (rev.2). Key decisions:
- **Gemini web can't use the loopback-gateway approach** (like Claude Desktop /
  Cursor chat) — the browser sends prompts from Google's servers, so there's no
  on-machine request path to occupy. The only local interception point is a
  **browser extension** working at the **DOM level** (MV3 forbids rewriting
  request bodies).
- **One-way redaction (rev.2).** No reversible map, no restore-for-display. The
  user's own message and every reply permanently show fixed tokens
  (`[REDACTED_PII_EMAIL]`). This deliberately deleted an entire complexity class
  and means the **existing `/redact` endpoint is reused UNCHANGED** (no new
  backend, no map field).
- **The real risk is Stage 3 (kill + re-fire), not the DOM read.** You can't
  pause a DOM event across an async gateway call, so the design fully kills the
  original submit (`preventDefault` + `stopImmediatePropagation` on a
  `document`-level capture listener) and independently re-fires a redacted
  submit. Two failure modes are handled explicitly: (a) **loop guard** — our own
  synthetic re-submit must not be re-intercepted (flag + event tag +
  `isTrusted:false` check, in `extension/src/interceptor-core.js`); (b)
  **framework model sync** — writing text must use the native setter + a real
  `input` event or the framework may submit stale pre-redaction text.
- **Testable core factored out.** Loop guard / fail-closed / tripwire-predicate
  are pure and unit-tested headlessly (`tests/phase-gemini-core.test.ts`); the
  selector/DOM code (`composer.js`) can only be validated against the live
  Gemini page (Stages 2/3/5, manual — see `extension/README.md`).
- **MV3 loading:** content scripts can't `import`, so an isolated-world
  `loader.js` injects the MAIN-world ES module via `web_accessible_resources`
  (no bundler, stays zero-build).
- **CORS blocker found + fixed (2026-07-20).** The gateway grants CORS to
  **loopback origins only** (`src/server.ts` `corsHeaders`, §5) and the `/redact`
  **POST** response carries no `Access-Control-Allow-Origin` at all (only the
  OPTIONS preflight does). So a fetch from the page (MAIN world, gemini.google.com
  origin — or even a loopback page origin) is browser-blocked → the extension
  would fail closed on every message. Fix: the gateway is left UNCHANGED; the
  `/redact` fetch moved to a **background service worker** (`src/background.js`),
  which has `host_permissions` for `127.0.0.1:8000` and is not subject to page
  CORS. Path is now MAIN → `CustomEvent` → isolated bridge →
  `chrome.runtime.sendMessage` → SW → fetch. The page never fetches the gateway.
- **e2e harness (Playwright, dev-only dep).** `npm run test:gemini-e2e` drives
  the REAL `content-main.js` in headless Chromium against a fake Gemini page
  backed by the real gateway, proving the Stage-3 mechanics: capture-phase
  intercept kills the original submit, redacted text is written+read
  (model-sync), a synthetic re-submit fires and is NOT re-intercepted (loop
  guard = exactly one gateway call + one send), zero raw PII leaves, and
  gateway-down blocks the send. 8/8. Does NOT cover the real gemini.google.com
  selectors or the SW/CORS plumbing end-to-end — those stay manual (Chrome).

**Cursor per-turn CHAT logging — Phase M (2026-07-27):** The Traffic Inspector showed no
prompt/output for Cursor (only counts-only `HOOK` rows) because Cursor chat never reaches
the gateway. Fixed the same way Gemini was: replay each finished turn from the transcript
**Cursor itself writes** — `transcript_path` is present in every hook payload (verified
live; format `{"role":"user"|"assistant","message":{"content":[{"type":"text"|"tool_use"}]}}`
plus `{"type":"turn_ended"}` markers). `scripts/cursor-turn-log-hook.mjs` (wired to `stop`,
**fail-OPEN** — logging must never break a session) reads the new turns and POSTs raw text
over loopback to `/log-turn`, which redacts and stores **redacted only**. Dedupe is a
counts-only state file (`cursor-turnlog-state.json`) so a re-fire never double-logs; a
failed post is retried on the next turn. Cursor's `<user_query>`/`<timestamp>` envelope is
stripped so the row shows what the user actually typed. `/log-turn` gained a `provider`
param — Cursor turns store as **`openai`** (its API family) because `Provider` is a FROZEN
contract; the console labels `cursor-*` rows "cursor" for display. **Live-verified: 7 real
turns rendered with prompt + assistant output.** Suite 121/121.
- Also fixed: HOOK rows rendered *"(could not parse request — snapshot may be truncated;
 raise SNAPSHOT_CHARS)"*, which was misleading — audit entries store an EMPTY snapshot by
 design and raising `SNAPSHOT_CHARS` would change nothing. Now says so (`clean-view.ts`).
- Also fixed: `tests/phase-l.test.ts` used `port + 1` as its "dead" port, which another
 parallel test file's gateway can occupy — real flake, exposed by adding a test file.

**Turn-log dedupe broke on transcript COMPACTION — FIXED (2026-07-28):** Dedupe stored a
COUNT of turns logged per transcript, which assumes the file only grows. Cursor **compacts**
a long session (summarizes and rewrites the transcript in place), leaving the counter AHEAD
of the content — found live at **17 logged vs 6 present** — so `turns.length <= already` was
true forever and that session **silently stopped logging**. Caught only because a live audit
test showed an empty traffic log. Dedupe is now **per-turn content hashes**
(`{ logged: [sha256(prompt\0response)] }`, capped 500/transcript, hashes only — no text on
disk), which survive a rewrite. A failed POST no longer records its hash, so the retry path
is unchanged.
- **The first fix still wedged on the REAL state** (caught by live testing, not the suite):
 migrating the legacy counter marked *every* remaining turn as logged and returned before
 persisting, so each run re-read the counter and re-wedged. Migration now clamps to
 `turns.length - 1` — the hook fires BECAUSE a turn just ended, so the newest turn must stay
 loggable — and state is persisted on **every** path, converting counter → hashes once.
- Regressions: `tests/phase-m.test.ts` "compacted transcript keeps logging" and "legacy
 counter ahead of a compacted transcript still logs the newest turn". Suite 127/127.

**Cursor QUEUED-MESSAGE bypass — FOUND LIVE, NOT FIXABLE, AUDITED (Phase N, 2026-07-27):**
A message **queued while the agent is busy** is delivered to the model with **no
`beforeSubmitPrompt` invocation at all** — not an allow, not a deny, the gate is never asked.
Proved from `prompt-hook-shape.log`: the invocation count did **not move** across two queued
sends, one carrying a real address, while Cursor's UI showed "2 Queued". A composer send
while idle behaves correctly (hook fires, denies, and the message never enters the
transcript). **No hook can close this** — no other Cursor hook carries prompt text
(`sessionStart`/`beforeMCPExecution` don't see prompts, `preToolUse`/`postToolUse` are tool
payloads, `stop` is after the answer), so a queued send is committed before our code runs.
Also learned: the transcript does **not** contain queued messages while they're queued (it's
written on delivery), so the §7.1 pending-message scan is blind to the queue — it only
refuses *subsequent* sends once a denied message is already in history.
- **Built instead: an audit trail.** `cursor-redact-hook.mjs` records a **SHA-256 hash** of
 every prompt it approves (`cursor-approved-prompts.json`, ring-capped 500 — hashes only, no
 prompt text on disk); `cursor-turn-log-hook.mjs` hashes each delivered message and sends
 `unchecked: true` to `/log-turn` when one has no matching hash. New optional
 `LogEntry.unchecked` (additive, same shape as `blocked`) renders as an `unchecked` pill,
 red when the row also has PII. **`unchecked` + `piiDetected` = a confirmed leak**, plus a
 loud stderr line. **An empty ledger flags nothing** (first install / cleared state can't be
 distinguished from a bypass; crying wolf on every historical turn is worse than no audit).
- Cursor prompt coverage is therefore **block-on-composer-send, audit-on-queue**. The real
 fix is upstream — Cursor must invoke `beforeSubmitPrompt` on the drain path. Worth filing.
- Full writeup: `CURSOR_INTEGRATION_PLAN.md` §7.3 (+ limitation #9). Suite 125/125.

**Cursor AUTO-ATTACHED-FILE bypass — FOUND LIVE, NOT BLOCKABLE, AUDITED (Phase O, 2026-07-28):**
A file the user has **OPEN or SELECTED** (no `@`-mention) is auto-inlined by Cursor into the
request as an `<attached_files>` block — and that block is **not in the `beforeSubmitPrompt`
payload**. Proved from `prompt-hook-shape.log` (12:32 test): the hook fired and **ALLOWED**
with `ctx.prompt` = only the 32-char typed text and `attachments` = only `type:"rule"` refs
(`CLAUDE.md`/`AGENTS.md`); the selected `pii-block-test.txt` (real email/SSN/card) was
nowhere in `ctx`, yet the transcript's `<attached_files>` carried it and the model read it.
So this is the **same wall as the queue bypass** — no prompt text, no file path, nothing to
gate — and the `@`-mention fix (§7.1) can't catch it either (no `@token` to resolve). This is
distinct from a queued send: the hook *does* fire, it just can't see the attachment.
- **Worse, it was also INVISIBLE:** `cursor-turn-log-hook.mjs`'s `userMessage()` strips
 `<attached_files>` for display, and the stripped text was also what got scanned — so the
 console row read **"no PII"** on a real leak.
- **Fix (visibility only — blocking stays impossible):** the turn-log hook now extracts
 `<attached_files>` blocks (`attachmentsOf`, **that tag ONLY** — a whole-message scan would
 hit Cursor's stamped `user_email` and flag every turn) and sends them as a new `scanExtra`
 field to `/log-turn`. The gateway redacts `scanExtra` to **count** its PII, folds those
 counts into `matchedRules.inbound` + `piiDetected`, and sets `entry.unchecked = true` when
 the attachment carried PII — **without storing or displaying the file dump** (counts-only,
 like the Phase L tool audit). Approval of the *typed* prompt does **not** clear the flag
 (the live bug: the typed text was allowed, the attachment still leaked). The clean view
 still shows only what the user typed.
- Cursor prompt coverage is now **block-on-composer-send + `@`-mention; audit-on-queue +
 auto-attach**. The `unchecked` pill + PII = confirmed leak covers both unblockable paths.
 Real block-side fix is upstream (Cursor surfacing attachment content to `beforeSubmitPrompt`)
 or a Cursor setting to disable auto-include of open/selected files. `tests/phase-o.test.ts`.
 Suite 130/130.

**Unblockable-leak desktop alert + upstream writeup (2026-07-29):** The `unchecked`+PII
pill is easy to miss and neither path can be blocked, so a confirmed leak now also fires a
**best-effort desktop notification** (`lib.mjs` `notifyDesktop`, macOS `osascript` / Linux
`notify-send`, zero-dep, fail-open, **counts only — never the leaked text**), gated by the
pure `isConfirmedLeak(turn, json)` in `cursor-turn-log-hook.mjs`. Suppress with
`GATEWAY_NO_DESKTOP_NOTIFY=1` (set in the hook tests). `doctor` now prints a non-failing
`[NOTE]` naming the two unblockable paths + the mitigation. Both Cursor feature requests are
written up file-ready in **`CURSOR_UPSTREAM_REQUESTS.md`** (invoke `beforeSubmitPrompt` on
queue-drain; surface auto-attached file content). `tests/leak-alert.test.ts` (3/3). Suite 133/133.

**IPv6 loopback false positive — FIXED (2026-07-27):** The `IPV6` rule had no `validate`,
so the literal `::1` was treated as PII. This **blocked editing this project's own
`src/server.ts`** (its loopback-origin check cites `::1` in a comment) — the block hook is
not just theoretical friction. `isPublicIpv6` now exempts loopback/unspecified, mirroring
the `isPublicIpv4` carve-out that already existed for `127.0.0.1`. Real IPv6 addresses
still redact; wall-clock `12:34:56` still untouched.

**Cursor `@`-mention bypass — FOUND LIVE + FIXED (2026-07-27):** Attaching a file with
`@name (1-6)` inlined its contents into the request with **both** hooks silent, so raw PII
reached the model. Found by live testing, not by the suite: a file `beforeReadFile` had
just blocked was delivered in full one message later via `@`. Cause (proved by a payload
capture): `beforeReadFile` never fires (Cursor inlines the attachment — no agent file read
happens), and `beforeSubmitPrompt` receives only the mention TEXT — its `attachments` array
holds **only `type:"rule"` path refs** (`CLAUDE.md`/`AGENTS.md`), never the mentioned file,
and no field carries content. Fix: `cursor-redact-hook.mjs` resolves `@`-tokens from
`ctx.prompt` against `ctx.workspace_roots`, reads those files, and scans each via `/detect`;
unresolvable tokens (`@Web`, `@Symbol`, missing files) are skipped and resolution stays
inside a workspace root. **Do NOT "fix" this by scanning the whole hook payload** — Cursor
stamps its own `user_email` (and a `transcript_path` containing it) on EVERY prompt, so a
whole-stdin scan denies every message the user sends; per-field capture showed all fields
clean except `user_email`. A test guards that trap. The hook also gained an **opt-in schema
capture** (`touch ~/.secure-llm-gateway/hook-capture` → `prompt-hook-shape.log`) that logs
key paths/types/string LENGTHS + per-field counts-only PII verdicts — **never raw payload**,
unlike the Phase L capture — for re-checking the payload shape after a Cursor upgrade.
Suite 121/121. Full writeup: `CURSOR_INTEGRATION_PLAN.md` §7.1.

**Cursor architecture finding (2026-07-14):** Cursor CHAT cannot be routed through a
loopback gateway — Cursor makes provider calls from its OWN cloud servers and bans
private-network base URLs ("Access to private networks is forbidden"). Confirmed live
(gpt-4o probe). So base-URL redaction (Phase J) is unshippable for Cursor chat; the shim
stays valid for Claude Code / direct callers. Cursor coverage is therefore: block-if-PII
(K) on prompts/file-reads + tool-data SCRUB (L) on preToolUse/postToolUse. Full writeup:
`CURSOR_BLOCKER_REPORT.md`, `CURSOR_REDACTION_BRIEF.md`. Hook-capability correction: Cursor
hooks are NOT all block-only — `preToolUse` (updated_input) and `postToolUse`
(updated_mcp_tool_output) CAN rewrite; the prompt/file hooks we use are block-only.

**`/models` root-path fix (2026-07-13):** `/models` handler now matches both `/openai`-
prefixed and bare-root paths (`^/(?:openai/)?(?:v1/)?models$`) — a bare-root Cursor base URL
404'd validation while chat worked at root. Regression in `tests/phase-j.test.ts`.

**`configure-cursor` merge bug FIXED (2026-07-14):** now writes our MCP entry as a fresh
HTTP-only object (replace, not deep-merge), so a prior stdio-shaped entry leaves no stale
`command`/`args`/`envFile` keys; other servers preserved. Regression in `tests/phase-i.test.ts`.

**Operational bootstrap (verified 2026-07-10):** The single bootstrap command is
`node scripts/gateway-service.mjs install` — it registers the per-user service, runs
`configure-clients` (global `~/.claude/settings.json`: `ANTHROPIC_BASE_URL` + SessionStart
hook + user-scope `secure-gateway` MCP; `~/.cursor/mcp.json` + `hooks.json`), and starts
fail-closed. **No runtime deps to install** (zero-dep is a hard constraint; the only
`npm install` is dev-only `typescript`/`@types/node` for `npm run build`). Verified live:
gateway healthy on `127.0.0.1:8000`, `doctor` 11/11 `[OK]`, Claude+Cursor hooks present,
outbound `EMAIL` redaction confirmed end-to-end from a real Claude Code prompt. See
DEVELOPERS.md §0 Quickstart.

**~~Known bug~~ FIXED — `configure-cursor` merge (fixed 2026-07-14):** `configure-cursor`
used to deep-merge into an existing `secure-gateway` entry, leaving stale stdio
`command`/`args`/`envFile` keys beside the new `type: http` + `url` when migrating from the
removed `mcp-remote-bridge.mjs`. Now writes our entry as a fresh HTTP-only object (replace,
not merge); other servers preserved. Regression test in `tests/phase-i.test.ts`.

**Loopback-only (2026-07-10):** All remote/cloud (Render) support was removed. The
gateway binds `127.0.0.1` only — `loadConfig` throws on any non-loopback `GATEWAY_HOST`
(no `GATEWAY_REMOTE`, no `0.0.0.0`, no `RENDER` detection). Deleted `render.yaml` and
`scripts/mcp-remote-bridge.mjs`; dropped `--remote-url`/`init-env` and the
`GATEWAY_PUBLIC_URL`/`GATEWAY_MCP_TOKEN` plumbing. Clients connect over loopback:
Claude via `ANTHROPIC_BASE_URL=http://127.0.0.1:8000` + `http` MCP, Cursor via `http`
MCP. Control plane is loopback-Origin gated (`GATEWAY_ADMIN_TOKEN` still allows a
cross-origin caller).

**Redaction expansion (2026-07-10):** Default rules grew beyond the original 7 to cover
high-signal Claude-session leaks — JWT, PEM private keys, DB/URL userinfo, expanded
API key families, US/+91 phones, Indian PAN + Verhoeff Aadhaar — with FP guards
(no bare 10-digit, no invalid Aadhaar, wall-clock untouched).

**Global client config fix (2026-07-10):** `scripts/gateway-service.mjs configure-clients`
now writes user-level Claude Code and Cursor configuration (`~/.claude/settings.json`,
`~/.cursor/mcp.json`, `~/.cursor/hooks.json`) so new repos inherit the gateway setup.
Cursor hooks use `scripts/cursor-gateway-hook.mjs` with fail-closed
`sessionStart`/`beforeMCPExecution` only; repo-local `.cursor/mcp.json` and
`.cursor/hooks.json` are no longer needed. Loopback `127.0.0.1` is preserved in
redacted hook messages, while public IPv4 addresses still redact.

**Ops + connection hardening (2026-07-10):** Unified Claude SessionStart on
`claude-session-hook.mjs` (start + fail-closed health). `gateway-service` adds
`restart`/`--force`, installId-aware health, stop-by-port. StreamRedactor scrubs
`thinking_delta`. `/api` POST mutations require `GATEWAY_ADMIN_TOKEN` when set.

**JWT rule fix (2026-07-10):** Payload no longer required to start with `eyJ`
(catches short payloads like `e30`); signature allows optional `=` padding. Added
multi-JWT and split-stream tests.

**Cursor real redaction — Phases J + K (2026-07-13):** Cursor now gets full
bidirectional redaction of chat/agent traffic (not just MCP inspection). Design
decisions worth remembering:
- **Single endpoint, model-name routing (NOT two endpoints).** Cursor exposes ONE
  global "Override OpenAI Base URL", so a second gateway path can never be reached
  alongside the first from one Cursor install. Point Cursor's OpenAI base URL at
  `http://127.0.0.1:8000/openai`; the proxy branches on the request's `model` id:
  a `claude-*` id or a configured alias (`CURSOR_TRANSLATE_MODELS`, default
  `claude-via-gateway`) → translate to the Anthropic Messages API and forward to
  Claude; any other model → pass through to OpenAI unchanged. See
  `shouldTranslate()` in `src/openai-anthropic-shim.ts` and the decision block in
  `src/proxy.ts`.
- **Translation shim** (`src/openai-anthropic-shim.ts`): `openaiToAnthropicRequest`,
  `anthropicToOpenAIResponse`, and `AnthropicToOpenAISSE` (streaming reframer that
  runs AFTER the existing StreamRedactor, so split-PII holdback is reused). Redaction
  engine untouched — it scrubs whatever body is present. Auth swap: client's OpenAI
  bearer dropped, server-side `ANTHROPIC_API_KEY` + `anthropic-version` added (real
  key never touches the client). Model map `CURSOR_MODEL_MAP` resolves alias → real
  Claude id; `CURSOR_DEFAULT_MODEL` / `CURSOR_MAX_TOKENS` fill gaps.
- **Model-policy ordering fix:** the block check now runs on the RESOLVED Claude
  model, so a blocked Claude model can't slip through under an OpenAI alias.
- **Hooks are block-only (Phase K).** Cursor's `beforeReadFile`/`beforeTabFileRead`/
  `beforeSubmitPrompt` can only allow/deny — they CANNOT rewrite content (verified
  against cursor.com/docs/hooks). `scripts/cursor-redact-hook.mjs` DETECTS PII via
  `POST /detect` (loopback-gated, uses the live rule set, never logs raw text) and
  DENIES when found; fail-closed on any error. Tab autocomplete file *reads* can be
  blocked but not scrubbed; Apply-from-Chat is uncoverable (Cursor's own backend).
- **Test note:** Phase K tests must spawn the hook with async `spawn`, not
  `spawnSync` — `spawnSync` blocks the parent event loop and deadlocks the
  in-process gateway serving `/detect`.
- Full rationale + limitations: `CURSOR_INTEGRATION_PLAN.md`.

**Cursor model-validation fix (2026-07-13):** Cursor validates a custom model by
`GET`ting `/v1/models` on its "Override OpenAI Base URL". That GET has no body, so
the shim can't route it, and it was proxied to real OpenAI → 401 on the dummy key →
Cursor reported *"Model name is not valid: claude-via-gateway"* and blocked the chat
before any translate request was sent. `src/server.ts` now answers
`GET /openai/(v1/)?models` locally with a synthetic OpenAI model list built from
`config.cursorTranslateModels` (loopback bind, no secrets). Regression test added to
`tests/phase-j.test.ts`. Suite 88/88.

**Cursor model-echo fix (2026-07-13, the actual "not valid" root cause):** After the
`/models` fix, Cursor *still* reported *"Model name is not valid: claude-via-gateway"*
on send. Real cause: the translate response echoed the RESOLVED Claude id
(`claude-sonnet-5`) in the OpenAI `model` field, but OpenAI-compatible clients validate
a custom model by matching the returned `model` against what they SENT. `src/proxy.ts`
now echoes the client's requested id (`clientModel`, the alias) in both the non-stream
`anthropicToOpenAIResponse` and the `AnthropicToOpenAISSE` reframer; the resolved id is
still used for policy checks, forwarding, and log entries. Verified live: request
`model:"claude-via-gateway"` → response `model:"claude-via-gateway"`, forwarded body
`model:"claude-sonnet-5"`.
- **Reverted a bad prior workaround:** `DEFAULT_CURSOR_TRANSLATE_MODELS` had been
  changed to `["claude-via-gateway", "gpt-4o"]` on the wrong theory that Cursor rejects
  invented names before calling the base URL. That hijacked genuine `gpt-4o` to Claude
  and broke the Phase-J pass-through test. Restored to `["claude-via-gateway"]`. The
  echo fix — not a gpt-4o alias — is the correct solution. Suite 88/88.

**Cursor `/models` root-path fix (2026-07-13, "not valid" recurrence):** The
`/models` handler only matched `^/openai/(v1/)?models$`. When Cursor's "Override
OpenAI Base URL" is set to the bare gateway root (`http://127.0.0.1:8000`, no
`/openai` segment), model validation GETs `/v1/models` at root → 404, while chat
POSTs at root (`/v1/chat/completions`) route to the shim and work — asymmetric, so
Cursor reports *"Model name is not valid: claude-via-gateway"* on send even though
the translate path is healthy. `src/server.ts` regex broadened to
`^/(?:openai/)?(?:v1/)?models$` so both root and `/openai`-prefixed probes answer
locally. Regression test in `tests/phase-j.test.ts`. Suite 89/89.


