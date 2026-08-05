# ChatGPT (chatgpt.com) coverage

What the extension does on ChatGPT, what was proven against the live page, and
the traps that cost real time. Spec: [`CHATGPT_EXTENSION.md`](CHATGPT_EXTENSION.md).
Gemini equivalent: [`WORKSPACE_COVERAGE.md`](WORKSPACE_COVERAGE.md).

Behavior is identical to the Gemini surfaces: intercept the submit in the capture
phase, kill it, redact through the local gateway, write the redacted text back,
re-fire a loop-guarded synthetic submit, log the finished turn. Nothing about the
gateway, the redaction rules, the interceptor or the tripwire's detection changed —
only a hostname-scoped table of selectors was added.

## 1. What is ChatGPT-specific (and where it lives)

Everything is in **`src/site-adapter.js`**, keyed by hostname. `composer.js` and
`content-main.js` read the adapter and are otherwise site-agnostic, so a ChatGPT
selector can never run on a Gemini page or vice-versa. An unknown host falls back
to the Gemini adapter — the behavior that existed before ChatGPT was added.

| Thing | ChatGPT value (confirmed live 2026-07-30) |
|---|---|
| Composer | `div#prompt-textarea[contenteditable="true"]`, `class="ProseMirror"` |
| Send button | `button[data-testid="send-button"]`, `aria-label="Send prompt"` |
| Generating | `button[data-testid="stop-button"]` (replaces send) |
| Model | `[data-testid="model-switcher-dropdown-button"]` → text `ChatGPT` / `ChatGPT 5 Thinking` |
| Reply | `[data-message-author-role="assistant"] .markdown` |
| Message POST | `https://chatgpt.com/backend-api/f/conversation` (also `/backend-api/conversation`) |
| Log row | `provider: "openai"`, `source: "chatgpt-web-extension"` |

`provider: "openai"` keeps the FROZEN `Provider` enum untouched — it is ChatGPT's
API family, and Cursor turns already log the same way. **The gateway required zero
changes**: `/redact` and `/log-turn` were reused as-is, and `isExtensionOrigin`
already grants the extension the hook endpoints.

Unlike Gemini's Gmail/Drive/Chat panels, ChatGPT marks turns semantically
(`data-message-author-role`), so the reply is captured by selector; the
shape-based `response-capture.js` fallback stays available but isn't needed.

## 2. The make-or-break: writing into ProseMirror

ChatGPT's composer keeps its **own document model** and the outgoing request is
built from THAT, not from the DOM node — so a synthetic write that only changes
the visible text ships the **raw** prompt. That is the failure the Firefox
Workspace panel still has, so it was proven on the WIRE before anything was built
(`npm run probe:chatgpt -- --send`): type the raw prompt with real keystrokes,
apply one write strategy, submit, and read the `/backend-api/conversation` body.

| Strategy | Composer after write | Wire body | Verdict |
|---|---|---|---|
| hidden companion `<textarea>` | textarea took the token, editor kept raw | **raw** | decoy — the request is not built from it |
| synthetic `paste` (`ClipboardEvent` + `DataTransfer`) | token **appended** (our Range selection ignored) | raw **and** token | worse than nothing |
| `beforeinput` / `insertReplacementText` | unchanged | **raw** | ProseMirror ignores it |
| **`execCommand("insertText")` after select-all** | token only | **token, no raw** | ✅ the model syncs |

The winner is the **existing Gemini `writeText`** — no new write code, and the
spec's suspicion that ProseMirror would need a paste dance turned out to be
wrong (the paste is in fact the one that corrupts the prompt).

Two traps this table locks in, both now covered by tests:

- **Never target the hidden `textarea[name="prompt-textarea"]`**
  (`wcDTda_fallbackTextarea`). It accepts a value, sits in the same form as the
  editor, and changes nothing that ships. `tests/phase-chatgpt.test.ts` asserts no
  composer selector can match a `<textarea>` — note the real composer's *id* is
  `prompt-textarea` while being a `<div>`, so the check is on element position.
- **Never "fix" a desync by relying on the tripwire.** If the model ever stops
  syncing, the tripwire aborts the send and the user sees a failure — fail-closed,
  not redaction. `npm run test:chatgpt-e2e` keeps that path proven (an editor that
  refuses programmatic edits ⇒ aborted, no raw PII) precisely so nobody mistakes it
  for a working state.

## 3. Tripwire scoping

`DEFAULT_CHATGPT_ENDPOINTS` adds `"/backend-api/conversation"`,
`"/backend-api/f/conversation"` and `"/backend-alt/conversation"`. Detection
(`bodyLooksRaw`, Luhn, the fetch/XHR wrapping) is unchanged.

`shouldInspectUrl` matches by substring, so the fragment also covers the sibling
`/backend-api/conversations…` list/search paths. That is deliberate and safe in
this direction: those are GETs with no body, and `bodyLooksRaw("")` is false, so
nothing is aborted — while anything in the conversation family that *did* carry
raw PII is exactly what should be blocked. Account/telemetry traffic
(`/backend-api/me`, `/ces/v1/t`, `ab.chatgpt.com/v1/rgstr`) is **not** inspected,
which is the false-positive class that once forced the tripwire off entirely.

## 4. Arming

`content-main.js` arms in the top frame, which already covers ChatGPT — it is a
single top-level SPA with no cross-origin composer iframe (unlike Gmail, whose
composer lives in a `chat.google.com` frame). The manifest therefore gives ChatGPT
its own content-script entry with `all_frames: false`, leaving the Gemini entry
untouched, and the `sawComposer` gate still prevents a composerless frame from
blocking ordinary input.

## 5. Tests

Headless (part of `npm test`):

```
node --experimental-strip-types --test tests/phase-chatgpt.test.ts
```

Covers host scoping, the disjointness of the two surfaces' selectors and endpoint
fragments, the composer-target trap above, the tripwire aborting a raw body on
ChatGPT's endpoint, model-label → log-slug mapping, and a real `/log-turn` round
trip asserting the row is `provider: openai` with **no** raw PII stored.

Browser (needs `npx playwright install chromium`):

```
npm run test:chatgpt-e2e
```

Drives the real content script against `test/e2e/fake-chatgpt.html`, which
reproduces ChatGPT's ProseMirror composer (a model that only follows real editing,
so a `textContent` write would ship stale text), the hidden companion textarea,
the send/stop buttons, the `data-message-author-role` reply markup, **and a
`div.ql-editor` Gemini decoy that must never win**. Asserts: token on the wire,
zero raw PII, exactly one send, exactly one `/redact` call, the turn logged as
`openai`/`chatgpt-web-extension` with the model and reply, gateway-down ⇒ blocked,
and a desynced editor ⇒ tripwire abort.

## 6. File uploads / attachments — GUARDED on ChatGPT (Phase Q)

**Was a total bypass; now guarded.** A file attached to a ChatGPT message never
passes through the composer, and the upload does not go to the conversation
endpoint the tripwire inspects — so PII inside an attached file used to be
**neither redacted nor blocked**. Voice input still is not (see §6.4). The guard is
adapter-driven, and currently **enabled for ChatGPT only**: the Gemini surfaces have
the same gap but their upload flow has not been probed, and arming an untested guard
on a live-verified surface would risk breaking attachments to close a documented gap.

Ceiling on any fix, stated up front:

- **Text-like files** (`.txt`, `.md`, `.csv`, `.json`, source) can be read with
  `FileReader`, sent through `/redact`, and replaced with a redacted `File` —
  the same kill-and-re-fire pattern the composer already uses.
- **PDF/DOCX/XLSX/images cannot be scrubbed.** Parsing them needs libraries, and
  zero runtime dependencies is a hard constraint. For those the only honest options
  are *block* or *allow unprotected*; there is no scrub path.

**Probe before building** (this project's standard — the ProseMirror write was
settled on the wire first). The deciding question is whether the upload is issued
by PAGE JavaScript, which our `fetch`/XHR wrapper and hence the tripwire can see,
or by something out of reach (service worker, `sendBeacon`, native form POST).
`test/e2e/upload-probe-console.js` answers it in a session you are already signed
into: paste it into DevTools, attach a file, run `uploadProbe.report()`. It records
**metadata only** — method, origin+path, body TYPE and size, and for multipart the
field/file names, sizes and MIME types — never body or file content, so a pasted
report cannot carry PII.

### Probe result — live chatgpt.com, 2026-07-30

**The upload IS reachable.** `serviceWorkers: []` (nothing escapes that way) and the
bytes leave as a **page-issued XHR `PUT` whose body is the `File` object**:

```
18348ms  file-selected  INPUT.CHANGE   pii-sample.txt  652 B  text/plain
18607ms  xhr  PUT  https://sdmntprcentralindia.oaiusercontent.com/files/<id>/raw
                   body: { kind: "File", bytes: 652, mime: "text/plain" }
37329ms  fetch POST https://chatgpt.com/backend-api/f/conversation   (1243 B)
```

Three things this pins down:

1. **The upload happens at ATTACH time, ~19s before the message is sent.** So
   interception at submit is far too late — and **attaching a file then removing it
   before sending already leaks it**. Attach-time is the only correct hook.
2. Both hooks exist: the `change` event on `input[type=file]` (fires 259ms before
   the `PUT`) and the `PUT` itself, which our XHR wrapper already fronts.
3. The upload host is **region-specific** (`sdmntprcentralindia…`), so any endpoint
   match must key on `oaiusercontent.com` + `/files/` + `/raw`, never that hostname.

### 6.1 What was built

Attach-time **kill-and-re-fire**, the composer's proven pattern applied to a
different entry point:

| Piece | File | Role |
|---|---|---|
| Decision core (pure) | `src/upload-core.js` | `classifyFile` / `decideUpload` / `isUploadUrl`. No DOM, no network — unit-tested in `tests/phase-upload.test.ts`. |
| DOM glue | `src/upload-guard.js` | Capture-phase `change` / `drop` / `paste`: swallow the event, clear the input, scrub via `/redact`, re-fire with a redacted `File`. |
| Wire backstop | `src/tripwire.js` | Aborts a `PUT` to an upload endpoint whose Blob body still reads as raw PII. |
| Surface config | `src/site-adapter.js` | `uploadGuard` + `uploadEndpoints`. ChatGPT on; Gemini `false`/`[]` pending its own probe. |

Decisions worth remembering:

- **Attach time, not submit** — forced by the 19-second gap measured above.
- **The input is CLEARED, not just left unread.** ChatGPT's uploader reads
  `input.files`; an input still holding the raw `File` could be picked up by a
  re-render or a poll before the async decision lands.
- **A binary extension beats a text MIME type.** `payroll.pdf` declared as
  `text/plain` is blocked. MIME is caller-supplied metadata; trusting it would send
  a PDF through a text scan, "pass" it clean, and upload it raw.
- **All-or-nothing on a multi-file attach.** Dropping one file while uploading the
  rest is a partial success the user would not notice.
- **A clean file uploads unchanged** — the original `File`, not a re-wrapped copy.
- **`send()` is deferred, not inspected inline,** in the backstop: the body is a
  Blob, so reading it is async. A read failure passes the request through — the
  backstop's contract is "abort when raw PII is *seen*", and the attach-time guard
  is the primary gate. Inherent ceiling: a genuinely binary body reads as garbage
  no rule matches, so unscannable formats can only be stopped at attach time.

### 6.1b Office files are SCRUBBED, not refused (Phase R)

Blocking every unreadable format was the crudest possible answer, and it refuses
exactly the files people attach at work. DOCX/XLSX/PPTX are the tractable case:
they are **ZIP archives of XML**, and `DecompressionStream`/`CompressionStream` are
browser built-ins — so the whole read → redact → rewrite loop is possible with **no
dependency**. Unlike a PDF this is a real scrub: a work document containing a
client's address is *cleaned and sent*, not blocked.

| Piece | File | Role |
|---|---|---|
| ZIP read/write | `src/zip.js` | Central directory + local headers + CRC-32, deflate via the built-in streams. No ZIP64, no encryption — anything else throws, and a throw means BLOCK. |
| Text parts | `src/ooxml.js` | `TEXT_PART_RE` picks the parts holding user text; rels/theme/docProps are never rewritten. |
| Extract & rebuild | `src/ooxml.js` | `extractParagraphs` / `rebuildPart`. |

**The critical detail: Word splits words across runs.** An address is routinely
stored as `<w:t>dana@</w:t><w:t>corp.example</w:t>` because of spell-check state or
revision ids, so scanning each run finds **nothing** — the same class of bug as PII
split across SSE chunks. Text is therefore concatenated **per paragraph** before it
is scanned. The e2e proves this specific case rather than assuming it.

Consequences worth knowing:

- **Only changed paragraphs are rewritten.** An untouched paragraph keeps its runs
  byte for byte, so formatting is preserved everywhere except where PII was found.
  A modified paragraph collapses into its first run, so a bold word mid-sentence
  can lose its styling. That is the accepted trade against leaking or refusing.
- **Paragraphs are joined with NUL (`\u0000`) for one gateway round trip.** It is
  not a legal XML character, so the split back is unambiguous, and no rule matches
  across it — PII is never "found" spanning two unrelated paragraphs.
- **A rebuild that does not line up paragraph-for-paragraph throws and BLOCKS.**
  Writing misaligned text into a document would be worse than refusing it.
- **Legacy `.doc`/`.xls`/`.ppt` are a different format entirely** and stay blocked.

### 6.2 Policy: unscannable formats are BLOCKED (with an escape hatch)

Chosen deliberately (2026-07-30). After Phase R the blocked set is much smaller:
scans, images, encrypted documents, PDFs and the legacy binary Office formats.
Those are refused with a message pointing at the picker rather than uploaded
unscanned. **A pasted screenshot is therefore blocked** — the most visible friction
of this choice, and intended behavior, not a bug.

**The escape hatch:** set `uploadPolicy: "warn"` in extension storage (managed or
local) and an unreadable file is uploaded and **audited** instead — a `/log-turn`
row flagged `unchecked`, which the Inspector already renders as a pill (the same
mechanism built for Cursor's unblockable paths in Phases N/O). Metadata only: name
and size, never content, which we could not read anyway. The default stays `block`.

To turn it on, from the extension's **service-worker** console (`chrome://extensions`
→ the extension's "service worker" link):

```js
chrome.storage.local.set({ uploadPolicy: "warn" });   // back to default: "block"
```

For a fleet, push the same key through `storage.managed`, which wins over local.
Either way it applies on the next page load.

> **This did not work for its first day.** The key has to cross the isolated→MAIN
> bridge, and `content-bridge.js`'s `CONFIG_KEYS` did not list `uploadPolicy` — so
> storage was read, the key was dropped, and MAIN kept `"block"` with no error
> anywhere. No test caught it because they all dispatch the MAIN-world config event
> directly and never exercise the bridge. Fixed 2026-07-31 and guarded by a test that
> asserts every `CONFIG.<key>` read in `content-main.js` is relayed. **If you add a
> config key, add it to `CONFIG_KEYS` or it is dead config.**
>
> The *behavior* behind the key had no coverage either — making the key reachable
> would still have left it unproven. It now has 9 checks in the Grok e2e: the PDF
> uploads, no block message appears, an `unchecked` row is filed naming the file with
> no content in it, and — the scoping case — a readable file whose gateway call fails
> still blocks under `warn`, so the hatch cannot degrade into "send everything raw
> whenever the gateway hiccups".

**What a `warn` row does and does not tell you.** It records that a file left
unscanned, with its name and size. Because the contents were unreadable, `piiDetected`
is never set — so unlike Cursor's `unchecked`+PII case it does **not** raise a
confirmed-leak alert. The row means *unknown*: not verified clean, not proven leaked.

The hatch is scoped to `upload-unscannable` on purpose. A gateway failure or a
rebuild that would not line up still blocks under either policy — those are **our**
failure to verify a file we *can* read, not a limitation of the format.

**Why the audit row is filed at attach time**, not with the turn: the upload happens
~19s before any message is sent, so a file attached and then abandoned has already
left the machine. Waiting for the turn would miss it.

### 6.3 Tests

- `tests/phase-upload.test.ts` — 4 headless tests over the pure core (part of `npm test`).
- `tests/phase-ooxml.test.ts` — 7 tests over zip + OOXML, including PII split across
  runs and a **validation of the rebuilt archive with the system `unzip -t`** (our
  own reader would happily round-trip a subtly malformed zip that Word rejects).
- `npm run test:chatgpt-e2e` — **36/36**, of which 19 are the upload gate: a PII text
  file uploads as a token with no raw PII; a PDF and a gateway-down text file are
  never uploaded and the user is told; a clean file's bytes are unchanged; and a raw
  upload that bypasses the DOM guard entirely is aborted by the tripwire. The fixture
  reproduces the live flow (page reads `input.files` on `change`, XHR-PUTs the `File`
  to a real `*.oaiusercontent.com` URL, intercepted by the harness) so the
  domain-suffix match is exercised rather than assumed. The Office trio uploads a
  real .docx with an address split across three runs and re-reads the uploaded bytes
  as a zip: token present, raw absent, untouched paragraph unchanged.

### 6.4 Live verification — real chatgpt.com, Chrome, 2026-07-30

Both halves confirmed on a signed-in session:

- **Scrub.** `pii-sample.txt` (the 14-type sample) attached → ChatGPT's own reply
  described the file it received as containing "placeholder tokens indicating that
  sensitive information (such as email, phone numbers, SSN, credit card, PAN,
  Aadhaar, API keys, etc.) has been redacted". Reading the model's description of
  the file is a stronger check than the Network panel: it is what actually arrived.
- **Exactly one upload per attach** (one preflight + one `xhr` to
  `*.oaiusercontent.com/files/<id>/raw`) — no raw-then-redacted double send. The
  DevTools **Initiator** column read `tripwire.js:209`, i.e. the PUT was issued
  through our deferred-send wrapper rather than around it.
- **Refuse.** `upload-block-test.pdf` — deliberately carrying a fake email + SSN, so
  a pass would have to come from the FORMAT rule and not from an empty scan → **no
  upload request at all**, no attachment chip, console:
  `File attachment blocked … upload-block-test.pdf: binary-extension`.
- **Office scrub (Phase R).** `scripts/gen-office-sample.mjs` builds a .docx whose
  email, SSN and card are each SPLIT ACROSS RUNS. Attached live, ChatGPT reported the
  document "includes redacted placeholders for sensitive information (such as an
  email, SSN, and credit card), while a non-sensitive paragraph remains unchanged".
  Beyond the redaction itself, this shows **OpenAI's own document parser accepted our
  rebuilt archive** — a stronger validation of `zip.js` than `unzip -t`, because a
  real consumer read it end to end.
  *Still untried:* a document straight out of Word/Google Docs, with themes, styles
  and far more parts. The fixtures are hand-built, so that is the likeliest surprise.

### 6.5 What is still NOT covered

- **Gemini/Workspace uploads are still unguarded.** `uploadGuard: false` there until
  the same probe is run on those surfaces.
- **Voice input** is untouched: it never becomes a `File` in the page.
- **Connectors / Drive-style pickers** that upload server-side never touch the
  browser, so nothing local can see them.

### 6.6 Firefox: the upload guard works, except pasting a file

The guard leans on four platform APIs Gecko has historically differed on, so they
were **measured** rather than assumed — `npm run probe:firefox-upload` launches a
real headless Firefox on a `file://` page (no login, no network) and tests each:

| Capability | Firefox 153 | Consequence |
|---|---|---|
| `deflate-raw` round trip (`zip.js`) | ✅ | Office scrub works |
| `File.text()` / `arrayBuffer()` | ✅ | attachments can be read |
| `DataTransfer` + `input.files` setter | ✅ | file-picker re-fire works |
| `DragEvent` with a constructed `dataTransfer` | ✅ | drag-and-drop re-fire works |
| `ClipboardEvent` with `clipboardData` | ❌ **false** | see below |

**So on Firefox, pasting a FILE always ends in a block.** Gecko does not carry a
constructed `clipboardData` on a synthetic `ClipboardEvent`, so the guard cannot
re-fire the paste. It already handles this: it verifies the synthetic event
actually carries the files and, when it does not, blocks with "attach it with the
+ button instead". Fail-closed, no leak — but a real usability limit, and it
applies even to a clean text file. Pasting *text* is unaffected (that is the
composer path). Since images are unscannable and blocked by policy anyway, the
practical loss is narrow.

Two notes on the probe itself, both learned the hard way: Firefox's RDP tab list
does not expose `about:blank` (hence the `file://` page), and Marionette gives each
`executeScript` its own sandbox, so results stashed on `window` and polled from a
second call read back as nothing — it has to be **one** `ExecuteAsyncScript`.

**Live-confirmed on real chatgpt.com in Firefox, 2026-07-30** — all four paths:
the picker scrubs a text file, **drag-and-drop** scrubs one, the `.docx` comes
through with placeholders, and pasting a file blocks with the "+ button" message
rather than hanging or leaking. Drag-and-drop had **no** coverage anywhere before
this (the e2e drives the picker only), so Firefox is currently the only place that
path has been exercised at all — Chrome's drop path is still unproven.

## 7. Firefox

**ChatGPT works on Firefox** (unlike the Gemini Workspace panels) —
**live-verified on Firefox 153.0.1, 2026-07-30**, with the full 14-type sample from
`scripts/gen-pii-sample.mjs` in a single turn: every rule fired (EMAIL, PHONE_US,
PHONE_IN, SSN, CREDIT_CARD, PAN_IN, AADHAAR, IPV4, IPV6, JWT, API_KEY,
BEARER_TOKEN, CONN_STRING, PRIVATE_KEY), the logged row held tokens only, and the
reply was captured. A non-PII turn sent normally.

Both Firefox-specific risks were measured against the real page beforehand, and
neither probe needs a login or sends anything to OpenAI:

| Risk | Probe | Result |
|---|---|---|
| Page CSP refuses the MAIN-world module (Gecko applies page CSP to content-script-inserted `<script>`) — would mean no interceptor **and** no tripwire | `npm run probe:firefox-csp -- https://chatgpt.com/` | ✅ `tripwireInstalled: true` |
| The redacted write doesn't sync into **ProseMirror**'s model — the exact failure Firefox has on the Workspace Angular panels, where raw PII is XHR'd and the tripwire must abort | `npm run probe:firefox-chatgpt` | ✅ model took the write |

The sync probe is worth understanding, because a DOM-level check gives a **false
pass** here — that is how the Workspace bug survived so long. ProseMirror
re-renders from its own document model, so the probe types the raw text with
**trusted** Marionette keys (model = raw), applies `writeText`, and then sends
**one more trusted keystroke**. If the write only touched the DOM, that keystroke
re-renders the stale model and wipes the token; if the model really took it, the
token survives. It survives.

### The stale-package trap (this actually happened)

`extension/build/{firefox,safari}` is what you load into those browsers, and
**nothing regenerates it automatically**. After ChatGPT was added, the Firefox
package was still the pre-ChatGPT one: its manifest didn't list `chatgpt.com` and
it had no `site-adapter.js`, so the add-on **never injected on that host**. That
is worse than a normal bug — with no content script there is no interceptor *and*
no tripwire, so the page is simply **unprotected**, which is not fail-closed.

Two things now catch it:

- `npm run ext:build` regenerates every target (`ext:build:firefox` /
  `ext:build:safari` for one). **Re-run it after any `extension/src` or
  `manifest.json` change, then reload the add-on.**
- `tests/phase-cross-browser.test.ts` fails if an on-disk generated package
  doesn't match a freshly built one — comparing the manifest **and** the contents
  of every file it names (the manifest alone can match while a copied module is
  old or missing). It skips when nothing has been built, so CI is unaffected. It
  caught a stale Safari package the moment it was written.

## 8. Live probe (browser-gated, needs a login)

```
npm run probe:chatgpt                 # composer/send/model/reply DOM report
npm run probe:chatgpt -- --inspect    # + send/model/reply survey in a real conversation
npm run probe:chatgpt -- --send       # + the write-strategy table above (sends real messages)
npm run probe:chatgpt -- --extension  # loads the REAL extension and checks the wire + gateway log
```

Headful, against a persistent profile (log in once; cookies persist). The probe
value is synthetic and assembled at runtime, so no PII literal is stored in the
repo.

**`--extension` must run in Chrome for Testing, not branded Chrome.** Chrome 137+
removed `--load-extension` from branded builds, and it fails *silently*: the
browser loads no extension, the page is simply unprotected, and the raw prompt on
the wire looks exactly like a broken redaction path. That cost a full debugging
cycle here, so the probe now switches to `channel: "chromium"` for extension runs
and **hard-fails unless a `chrome-extension://` service worker is present**. Note
that build needs its own login (cookies are encrypted per-build via the macOS
Keychain), which is why manual verification in your own Chrome —
`chrome://extensions` → **Reload** the extension, then a **new** chatgpt.com tab —
is usually the faster route.
