# Gemini + ChatGPT + Grok + DeepSeek Web — PII Redaction Browser Extension

Best-effort, **fail-closed** PII redaction for the standalone Gemini web app
(`gemini.google.com`), **the Google Workspace "Ask Gemini" side panel**
(Gmail, Docs, Sheets, Slides, Chat — live-verified 2026-07-21),
**`chatgpt.com`** (added 2026-07-30), **`grok.com`** (added and live-verified
2026-07-31) and **`chat.deepseek.com`** (added 2026-08-03, **not yet
live-verified**). It rewrites a prompt through the **existing local gateway**
(`POST /redact`, unchanged) before the prompt leaves the browser.

> **DeepSeek note.** Adapter-only, **zero shared-code change** — its composer is a
> plain `<textarea>`, so the existing textarea write path handles it (the ONE
> surface whose composer selectors target a `<textarea>` rather than a
> contenteditable). Caveat worth knowing: DeepSeek **encrypts its request body**
> (WASM proof-of-work — a Network search for the typed text finds nothing), so the
> **G4 tripwire is blind on this surface**. Redaction still holds because the
> textarea is scrubbed *before* DeepSeek encrypts it, but the wire-level backstop
> can't verify it — so the composer intercept is the sole protection and the live
> textarea-write check is mandatory before trusting it. **Text redaction
> live-verified 2026-08-03.** Uploads probed + armed the same day (attach-time
> multipart `POST /api/v0/file/upload_file` — same shape Grok's guard handles);
> the upload body is plain FormData, so the tripwire backstop works on uploads
> even though it's blind on the encrypted chat send. Spec:
> [`DEEPSEEK_EXTENSION.md`](DEEPSEEK_EXTENSION.md).

> **ChatGPT note.** Same machinery, no gateway change: everything site-specific
> is a hostname-keyed table in `src/site-adapter.js`, so a ChatGPT selector never
> runs on a Gemini page. Its composer is ProseMirror, which builds the outgoing
> request from its **own document model** — the existing `execCommand("insertText")`
> write was proven on the wire before anything was built, and a hidden companion
> `textarea` is a decoy that must never be written. See
> [`CHATGPT_COVERAGE.md`](CHATGPT_COVERAGE.md).

> **Grok note.** Grok's composer is **Tiptap, which is ProseMirror** — the same
> editor family as ChatGPT — so the already-proven write path is reused with no
> change, and the same "never write a `<textarea>`" rule applies (the request is
> built from the editor's model, so a textarea write ships raw). Two things are
> genuinely Grok-specific. Its send control is an **unlabeled**
> `button[type="submit"]`, which none of the generic aria/testid click filters
> match, so `content-main.js` unions the site's own `liveSendSelector` into the
> click filter — without that, clicking send skips interception entirely. And its
> reply has **no semantic attribute at all** (rotating Tailwind classes,
> `<span class="animate-gaussian">` word spans), so `responseSelectors` is
> deliberately **empty** and the reply is captured by the **shape-based** path
> already proven on Gemini's obfuscated Gmail/Drive/Chat panels. Spec:
> [`GROK_EXTENSION.md`](GROK_EXTENSION.md). Uploads on Grok are **not** guarded —
> that flow has not been probed (see below).

> **Workspace note.** The Workspace panel is Google's `appsElements` composer
> (not Quill), it lives at **top-level DOM** (not shadow/iframe), and it renders a
> **disabled decoy** `aria="Submit"` button beside the real send — `fireSubmit`
> must click the **enabled + visible** one and dispatch a full pointer sequence
> (Gm3 Material buttons ignore a bare synthetic click). Its generate endpoint is
> lowercase `streamGenerate` on `appsgenaiservice`. See `REBUILD_PLAYBOOK.md` §3.11.

> Full design, rationale, risks, and phase gates: [`../scripts/gemini_imp.md`](../scripts/gemini_imp.md).
> Read §0 (scope honesty) and §7 (risks) before relying on this.

## What it is / isn't

- **Is:** a DOM-level interceptor. On submit it kills the original send, asks the
  local gateway to redact the text, writes the redacted text back, and re-fires
  a fresh submit.
- **One-way:** redaction is permanent. Values are **not** restored — your own
  sent message and every reply show tokens like `[REDACTED_PII_EMAIL]`. This is
  a deliberate rev.2 decision (see design doc) that removed all reversible-map
  complexity. The gateway endpoint is reused **unchanged**.
- **Isn't airtight.** It sits *beside* the request path, not *in* it (unlike the
  Claude Code gateway). A missed submit path, a lost timing race, or a Gemini UI
  change can leak silently — which is why it is built fail-closed and
  health-checked. Do not treat it as a guarantee.
- **Word-boundary limit.** Rules like SSN/PHONE/CARD/PAN/AADHAAR/IPV4 are
  `\b`-anchored (to avoid false positives), so PII **glued to adjacent characters
  with no separator** (e.g. `SSN078051120`, or a multi-line paste whose newlines
  Gemini strips → `0147India`) is not matched and goes out RAW. Rare in normal
  prose; see `scripts/gemini_imp.md` §7.11. Test coverage with
  `node scripts/gen-pii-sample.mjs` (all 14 rules verified live 2026-07-20).

## Architecture (files)

| File | World | Role |
|------|-------|------|
| `manifest.json` | — | MV3 manifest (Chrome), scoped to `gemini.google.com` + Workspace hosts + `chatgpt.com` + `grok.com` + `chat.deepseek.com`, loopback host permission only. Firefox/Safari variants are generated — see [Other browsers](#other-browsers-firefox--safari). |
| `src/site-adapter.js` | MAIN (pure data) | **Unit-tested** hostname → selectors/endpoints/log-labels table (`GEMINI_ADAPTER`, `CHATGPT_ADAPTER`, `GROK_ADAPTER`). The only place a surface differs; unknown hosts fall back to Gemini. |
| `src/browser-api.js` | isolated + background | Extension-namespace shim. Publishes `globalThis.geminiRedactBrowserApi` = `{ api, storageGet, storageSet, sendMessage }`, resolving **`chrome` before `browser`** (see [Other browsers](#other-browsers-firefox--safari)). |
| `src/loader.js` | isolated | Injects the MAIN-world ES module (MV3 content scripts can't `import`). Escalates a failed/CSP-refused load as `blocked`. |
| `src/background.js` | service worker (Chrome) / event page (Firefox, Safari) | The **only** component that fetches the gateway. Page-world fetch to `127.0.0.1` is CORS-blocked (gateway grants CORS to loopback + extension origins only); the background has `host_permissions` and is not subject to page CORS. |
| `src/content-bridge.js` | isolated | Relays config (`base`, `enabled`) from extension storage (managed > local) into MAIN, and relays redact requests MAIN→background→MAIN. No PII crosses to Google — only browser↔loopback. |
| `src/content-main.js` | MAIN | The Stage 3 core: capture-phase intercept on `document`, kill → redact → re-fire. |
| `src/interceptor-core.js` | MAIN (pure) | **Unit-tested** control logic: loop guard, synthetic-event recognition, fail-closed decision. |
| `src/composer.js` | MAIN | DOM glue: find composer (adapter fast-path → **heuristic self-heal** fallback), read text, write via native setter + `input` event, health check. Selectors come from `site-adapter.js`. |
| `src/composer-finder.js` | MAIN (pure) | **Unit-tested** Layer-1 scorer: ranks candidate editable boxes by shape (size, prompt-like label, near-send) so `findComposer` survives most Google DOM changes and rejects decoys (Sheets empty `role=textbox`). No DOM access. |
| `src/composer-learn.js` | MAIN (pure) | **Unit-tested** Layer-1.5 chooser: focus > learned fingerprint > heuristic. Turns "the box the user submits from" into ground truth; persists a PII-free fingerprint (via bridge → `chrome.storage.local`) to recall the composer after a redesign. No DOM access. |
| `src/response-capture.js` | MAIN | DOM glue for capturing the assistant reply on panels with **no stable selectors** (Gmail/Drive/Chat rotate class names every deploy). Anchors on the text just submitted and walks forward; feeds `response-finder.js`. Read-only — cannot affect whether a send is blocked. |
| `src/response-finder.js` | MAIN (pure) | **Unit-tested** reply scorer: ranks blocks after the user's message by shape (streamed growth, appeared-with-this-turn, non-interactive) and returns "nothing" rather than risk logging a suggestion chip. No DOM access. |
| `src/redact-client.js` | MAIN | `fetch` wrapper to the local gateway `/redact`. |
| `src/tripwire.js` | MAIN | Secondary net (**ON by default**): aborts an outgoing request to the surface's generate endpoint (Gemini's `StreamGenerate`, ChatGPT's `/backend-api/conversation`, Grok's `/rest/app-chat/conversations/`) whose body still contains raw PII (Luhn-checked, endpoint-scoped). DOM-independent — survives UI changes. Backup to the DOM path. |

The genuinely hard, failure-prone logic (loop guard §7 risk 2, fail-closed) is
in `interceptor-core.js` and is covered headlessly by
`../tests/phase-gemini-core.test.ts`. The DOM/selector code can only be
validated against the **live** Gemini page (Stages 2/3/5 below).

## Load it (dev)

1. Start the local gateway (default `127.0.0.1:8001`; if the installed service is already running, skip this): from repo root,
   `npm run dev` (or `node scripts/gateway-service.mjs install`).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select this `extension/` folder.
3. Open `https://gemini.google.com` (or `https://chatgpt.com`, or
   `https://grok.com`). Open DevTools console; you should see
   `[gemini-redact] content script active (MAIN world)`.

> **After a manifest change, click Reload ↻ on the extension card** and then open a
> **new** tab. An already-open tab keeps the old content-script registration, so a
> newly added host (this is how `chatgpt.com` and `grok.com` arrive) looks like it
> does nothing.

## Other browsers (Firefox + Safari)

Same code, same security model — only the manifest and the four
extension-API files differ. `extension/` itself stays the **Chrome** package;
per-browser packages are generated into `extension/build/` (gitignored):

```
npm run ext:build            # both
npm run ext:build:firefox    # -> extension/build/firefox
npm run ext:build:safari     # -> extension/build/safari
```

`extension/manifest.json` is the single source of truth for hosts, permissions
and web-accessible resources; `scripts/build-extension.mjs` copies `src/` and
patches only the keys that must differ. Port details and rationale:
[`CROSS_BROWSER_PORT.md`](CROSS_BROWSER_PORT.md).

> **Re-run `npm run ext:build` after ANY change under `extension/src` or to
> `manifest.json`, then reload the add-on.** Nothing regenerates these packages for
> you, and a stale one is not a harmless bug: when ChatGPT was added, the stale
> Firefox package didn't match `chatgpt.com`, so no content script injected there —
> no interceptor **and** no tripwire, i.e. the page was **unprotected** rather than
> fail-closed. `tests/phase-cross-browser.test.ts` now fails when an on-disk package
> differs from a freshly built one (manifest plus the contents of every file it
> names), so `npm test` catches this.

**The shim resolves `chrome` first, `browser` second — do not flip it.** Firefox
and Safari expose both namespaces, but `browser.*` is promise-only: it rejects
the trailing callback this extension passes everywhere, and
`browser.runtime.onMessage` ignores `return true` for a deferred `sendResponse`.
Under `chrome.*` both engines support the callback style, so the existing code
runs unchanged. (`storageGet`/`sendMessage` still tolerate a promise-only
namespace, so an engine shipping `browser` alone also works.) A regression here
fails **closed** — every send blocked — which is safe but unusable;
`tests/phase-cross-browser.test.ts` locks the order in.

### Firefox — verified working

```
npm run ext:build:firefox
npm run test:firefox-e2e       # real Firefox, real extension, real gateway (12 checks)
npm run probe:firefox-csp      # is the MAIN module allowed to run on live gemini.google.com?
npm run probe:firefox-csp -- https://chatgpt.com/   # same question for ChatGPT: PASSES
npm run probe:firefox-chatgpt  # does the redacted write sync into ProseMirror? PASSES
```

> If a run dies with `ECONNREFUSED` on the debugger/Marionette port, a Firefox from
> a previous run is still holding it: `pkill -f gemini-redact-ff` and retry.

To load it by hand: `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on** → pick `extension/build/firefox/manifest.json`. Firefox MV3 treats host
permissions as opt-in, so if gateway calls fail, grant them in `about:addons` →
the extension → **Permissions** → *Access your data for 127.0.0.1*.

`test:firefox-e2e` needs no extra dependency: it installs the add-on over
Firefox's remote debugging protocol (`firefox-rdp.mts` — the one thing `web-ext`
is normally needed for) and types with **trusted** keystrokes over Marionette
(`firefox-marionette.mts`), because the loop guard deliberately ignores
`isTrusted:false` events. It serves the fake composer under a CSP copied from
gemini.google.com (nonce + `strict-dynamic`).

Firefox-specific behavior worth knowing:

- **No MV3 background service worker** (Firefox bug 1573659). The generated
  manifest uses `background.scripts` + `type: "module"` (an event page). Verified:
  Firefox 153 loads it with **zero manifest warnings** and reports the background
  `RUNNING`.
- **Cross-world objects need cloning.** Gecko isolates the content-script
  compartment from the page's, so a `CustomEvent` `detail` created in
  `content-bridge.js` is opaque to MAIN world — reading a property throws
  *"Permission denied to access property"*. The bridge hands data over with
  `cloneInto(detail, window)` (Gecko-only, capability-tested so Chrome/Safari are
  unaffected). Without it MAIN never reads the redaction result, times out, and
  blocks every send.
- **The page CSP does not stop the MAIN-world injection.** Gecko applies a page's
  CSP to script tags a content script inserts (bugs 1267027 / 1591983), and
  Gemini serves `script-src 'nonce-…' 'strict-dynamic'`, so this was the port's
  biggest risk — a refused load means no interceptor *and* no tripwire, i.e. a
  silent leak. Checked against the real page (`npm run probe:firefox-csp`, no
  Google account needed): the module loads and the tripwire installs. `loader.js`
  now also raises `blocked` if the load ever *is* refused. **`chatgpt.com` was
  checked the same way and also passes.**
- **ChatGPT works on Firefox.** Gecko fails to sync a programmatic write into the
  *Workspace* panels' Angular model (see the Safari/Workspace caveats and CLAUDE.md),
  so ProseMirror was the open question — `npm run probe:firefox-chatgpt` answers it
  on the real page with no login: the model takes the redacted write. Note the probe
  does **not** assert on the DOM, which gives a false pass here; it types with
  trusted keys, writes, then sends **one more trusted keystroke**, because
  ProseMirror re-renders from its own model and a stale model wipes the token.

### Safari — packaged, **not verified here**

The Safari package is generated by `npm run ext:build:safari`, but it could not
be built or run in this environment: `xcrun safari-web-extension-converter`
ships only with **full Xcode**, and only the Command Line Tools are installed.
So the steps below are unverified, and the loopback question in particular is
open.

```
npm run ext:build:safari
xcrun safari-web-extension-converter extension/build/safari      # needs full Xcode
```

Then in the generated Xcode project, before anything will reach the gateway:

1. **Extension target → Signing & Capabilities → App Sandbox → Network →
   Outgoing Connections (Client)** (`com.apple.security.network.client`). A
   sandboxed extension cannot open *any* socket without it, loopback included.
2. Safari → Settings → Extensions → enable it, and allow it on
   `gemini.google.com` (and the Workspace hosts).
3. macOS ≥ 15 gates local-network access per app: **System Settings → Privacy &
   Security → Local Network → Safari** must be on.

Known Safari specifics already handled in the port:

- **Event page, never a service worker.** Safari's MV3 background *service
  worker* enforces CORS on extension fetches (Apple DTS thread 654839), which
  would break the loopback call; from a background **script** Safari skips CORS
  for hosts in `host_permissions`. The Safari manifest therefore declares only
  `background.scripts`, so Safari cannot pick the broken environment.
- **Rotating extension origin.** Safari changes the
  `safari-web-extension://<GUID>` origin on every launch. The gateway matches the
  *scheme*, not a fixed id (`src/server.ts` `isExtensionOrigin`), so no gateway
  change is needed.
- **No `storage.managed`.** The shim resolves a missing area to `{}`, so config
  degrades to `storage.local` instead of throwing.

Do **not** work around a Safari block by moving the gateway fetch into the page
(that reintroduces the CORS block the background exists to avoid) or by
weakening fail-closed. If Safari refuses the loopback fetch, the extension blocks
sends — no silent leak — and that is the honest outcome to report.

## Manual verification (browser-gated stages)

These gates require the real site and are **not** covered by `npm test`:

- **Stage 2 (skeleton):** console shows the active line; on an unmatched tab the
  script does **not** activate. If the composer isn't found, adjust that surface's
  `composerSelectors` in `src/site-adapter.js`.
- **Stage 3 (the hard core):** type a prompt with an email, hit Enter. In the
  **Network** tab, confirm the outgoing request contains `[REDACTED_PII_EMAIL]`
  and **zero** raw PII, and that there is exactly **one** request (not two, and
  no loop). Repeat with the Send button. Stop the gateway → confirm the send is
  **blocked** (fail-closed), not sent raw.
- **Stage 4 (tripwire):** now **ON by default** (Luhn + endpoint-scoped). Confirm
  live: (a) a normal send's generate request matches `shouldInspectUrl` and is
  **not** blocked; (b) Google telemetry/analytics is **not** aborted on load/idle
  (the regression that forced it off); (c) with a selector deliberately broken so
  the DOM path misses, raw PII on the generate endpoint **is** aborted. If the
  generate URL doesn't match, add its substring to that surface's
  `tripwireEndpoints` in `src/site-adapter.js`. The Service-Worker blind spot is
  documented in the design doc §7 / playbook §3.7.
- **Stage 5 (health/enterprise):** break a selector in `composer.js` → confirm
  the health check fires `gemini-redact:blocked` and sending is disabled rather
  than silently leaking.

### Grok — live-verified 2026-07-31 (Chrome); re-run this after any Grok UI change

Verified on real `grok.com` in Chrome: the full 14-type sample
(`node scripts/gen-pii-sample.mjs`) went out with **every rule tokenised**, sent
by **mouse-clicking the send arrow** (the Grok-specific path), and Grok's own
reply confirmed the fields "were already redacted before they reached me". A
cross-request search for the raw address across all 159 captured requests found
nothing. Uploads are now guarded and live-verified too (see "Grok uploads" below);
**Firefox on Grok is still untried**, as is drag-and-drop.

Re-run this after a Grok UI change, in this order:

1. **The wire (the one that matters).** Type a prompt containing an email and
   send. This is the ProseMirror-sync question: the DOM can show the token while
   the editor's model still ships the raw text, so a DOM check gives a false pass.

   Don't hunt for the request by name — **`load-responses` is used for BOTH the
   message POST and a plain history fetch** (the latter's payload is just
   `{"responseIds":[…]}`), so clicking a row by name lands on the wrong instance
   and makes it look like the endpoint is wrong. Use the Network panel's
   **cross-request search** (the magnifier next to the filter funnel) instead:
   - search a distinctive word of your prompt → the hit should read
     `"message":"… [REDACTED_PII_EMAIL]","sender":"human"`;
   - search the **raw** address → **"No matches found"** is the pass. That second
     search is the one that decides it; the first only says where the text lives.
2. **Both submit gestures.** Enter *and* a mouse click on the send arrow — the
   click path is Grok-specific (unlabeled button) and is the one most likely to
   regress.
3. **A normal, non-PII message sends and replies normally.** If the model write
   does not sync, the tripwire aborts and Grok shows an error instead — that is
   fail-closed, not working.
4. **The log row.** The Traffic Inspector should show a `CHAT` row with
   `provider: openai` / `source: grok-web-extension`, the model, and the
   captured reply. A blank reply is a cosmetic shape-capture miss, not a
   security problem; a missing row means the send never reached `/log-turn`.
5. **Gateway down → send blocked**, not sent raw.

Known-unverified by design: the `modelSelectors` (best-effort — if they miss, the row
just reads `grok`). File **uploads** were unguarded until they were probed on
2026-07-31; the guard is now armed (see "Grok uploads" below) but has not yet been
re-verified against the live site.

### Probing a new surface's file uploads (before writing any guard)

Attaching a file bypasses the composer entirely, so a surface with
`uploadGuard: false` uploads attachments **completely unscanned**. Do not start
by writing a guard: on ChatGPT the measurements changed the design, because the
bytes turned out to leave at **attach** time, ~19 seconds *before* the message was
sent — a guard on submit would have been useless, and it means attaching a file
then removing it before sending has already leaked it.

`test/e2e/upload-probe-console.js` is **surface-agnostic** — one copy, used for
ChatGPT and reusable as-is for Grok or Gemini. In a signed-in tab, DevTools →
Console (Firefox needs you to type `allow pasting` first), paste the whole file,
then:

1. Attach a small **text** file (`node scripts/gen-pii-sample.mjs`).
2. Send the message, then run `uploadProbe.mark("sent")` — that timestamp is what
   turns "the bytes left at some point" into the attach-vs-send answer.
3. Run `uploadProbe.report()` and read `summary` first; `uploadProbe.stop()`
   restores everything.

It records **metadata only** — method, origin+path, body *type* and byte size,
and for multipart the field/file names. File content is never read, so nothing you
attach can end up in a report you paste back.

`summary` answers the four questions that decide the work:

| Field | What it decides |
| --- | --- |
| `reachableFromPage` | `false` means the upload is issued out of reach (service worker, native form POST) and this surface **cannot** be guarded the way ChatGPT is. |
| `inconclusive` | File-shaped traffic was seen but nothing confidently carries the file. Inspect `weakCandidates` by hand — do **not** read this as "nothing to guard". |
| `leavesAtAttachTime`, `msFromUploadToSend` | Where to hook. A large positive gap means attach-time, like ChatGPT. |
| `candidateEndpoints` | The adapter's `uploadEndpoints`. `host` is a domain **suffix** because upload hosts are often region-specific; `pathFull` shows what was actually seen, since `path` is a heuristic. |
| `bodyShapes`, `pageReadTheFile`, `needsNewGuardWork` | How much work it is. Today's guard and tripwire backstop only handle a raw **File/Blob** body. Multipart `FormData`, or the page reading the file itself and inlining base64 into JSON, are **new work** — `needsNewGuardWork: true` says so explicitly. |

Candidates are **ranked**, and only "strong" ones (sent after the attach, and
either naming the attached file in a multipart part or matching its size for the
body kind) drive the conclusions. This is not fussiness — Grok's analytics POST
`Blob`s to `/api/log_metric` and 12–26 KB JSON to `/_data/v1/a/t/`, and a
shape-only filter ranked a beacon sent **5.8 s before the attach** as "the first
upload", producing a negative attach→upload gap. Everything ruled out still
appears in `weakCandidates`.

The probe's own analysis is validated headlessly by
`npm run probe:upload-selfcheck` (33 checks), which replays the known ChatGPT and
Grok traces plus the FormData / inlined-base64 / nothing-reachable / inconclusive
cases and asserts the summary. Run it after touching the probe. It has already
caught three real bugs: the attach event counted as its own upload (zeroing the
attach→upload timing), an API version suffix (`upload-file-v2`) treated as a
per-request id (truncating Grok's endpoint to a useless `/http/`), and telemetry
outranking the real upload.

### Grok uploads — measured 2026-07-31, guard ARMED and LIVE-VERIFIED

```
7197ms  file-selected  INPUT.CHANGE  pii-sample.txt  652 B  text/plain
7232ms  fetch POST     https://grok.com/http/upload-file-v2/direct
                       FormData -> parts: [{ field:"file", File "pii-sample.txt", 652 B }]
30842ms mark "sent"    <- 24 SECONDS LATER
```

Two runs agreed, and the guard is now built on those measurements:

- **Guardable.** A plain page-issued `fetch`, no service worker, so the existing
  wrapper sees it.
- **Attach-time, harder than ChatGPT** — 35 ms after the attach (ChatGPT: 259 ms)
  and ~24–45 s before the send. Hook `change`/`drop`/`paste`, never submit.
  Attaching then removing before sending has already leaked the file.
- **Endpoint** `{ host: "grok.com", path: "/upload-file-v2/" }` — same-origin and
  not region-sharded, so none of the domain-suffix care `*.oaiusercontent.com`
  needed.
- **The body is multipart `FormData`, not a raw `File`.** The attach-time DOM guard
  needed no change for this — it swaps a redacted `File` into
  `input.files`/`DataTransfer` and the page builds its own body from that — but the
  wire-level backstop did, in two places: `isBinaryBody` only recognised a `Blob`
  (now `uploadBlobsOf`, which unpacks multipart and returns **all** file parts), and
  **the backstop was wired into `XHR.send` only**. ChatGPT PUTs over XHR, so `fetch`
  had never needed it; Grok posts with `fetch`, so before this it had no wire-level
  net at all whatever the body shape.
- Caveat: `pageReadTheFile` was `false`, so Grok does not re-encode the file — the
  large `_data/v1/a/t/` JSON bodies are analytics, not a second copy of it. That
  is inferred from metadata (no `FileReader` call), not from reading bodies.

**Live-verified on real grok.com 2026-07-31, and it is the strongest upload evidence
in the project** — Grok printed both files back verbatim instead of summarising them,
so there is nothing to take on trust:

- `pii-sample.txt` → Grok listed the whole file with **all 14 default rules fired**
  (EMAIL, PHONE_US, PHONE_IN, SSN, CREDIT_CARD, PAN_IN, AADHAAR, IPV4, IPV6, JWT,
  API_KEY, BEARER_TOKEN, CONN_STRING, PRIVATE_KEY) and its own verdict, "All the
  sensitive values appear to be redacted."
- `upload-office-test.docx` → the email, SSN and card came back redacted with the
  clean paragraph unchanged. Those three are **split across Word runs** in the
  fixture, so this proves the per-paragraph concatenation on the real path *and*
  that **xAI's document parser accepted our rebuilt zip** — a second independent
  consumer after OpenAI's, which is a stronger check on `zip.js` than `unzip -t`.
- A PDF could not be attached at all (`binary-extension`) — intended.

Watch for one diagnostic while doing this: if every send *and* upload suddenly fails
with "PII gateway unreachable — message blocked (fail-closed)" while the gateway is
healthy, Chrome is still running the **old service worker**. Reload the extension and
open a new tab. The page console only shows the generic fail-closed line; the real
error is in the service worker's own console.

**Drag-and-drop is now covered by the Grok e2e (46/46) — the first automated drop
coverage on any surface.** It is not a variation of the picker: the guard re-fires a
constructed `DragEvent` rather than writing `input.files`, and that event has to
bubble back to the page's own drop handler to be honoured, so a re-fire the page
never receives would look exactly like a successful block.

Those checks were mutation-tested by neutering the drop listener, and the result is
worth knowing: 6 of the 10 failed (they are load-bearing), but four still passed
because the **tripwire aborted the raw multipart upload on its own** — `blocked` came
back as `tripwire-upload` rather than `upload-blocked`. So the two layers really are
independent for a text file. **But that only worked because the fake PDF contained a
scannable email.** A real binary PDF reads as bytes no rule matches, so the tripwire
cannot see it and the attach-time guard is the *only* thing stopping unscannable
formats. Don't conclude the drop guard is redundant.

**Drag-and-drop is also LIVE-VERIFIED on real grok.com in Chrome (2026-07-31), which
is the first live drop check on Chrome on any surface** — ChatGPT's drop path had only
ever been exercised on Firefox. `pii-sample.txt` dragged in from Finder came back from
Grok with all 14 types tokenised. That is precisely what the harness cannot establish:
its `DragEvent` is constructed in page JavaScript, so only a real OS drag shows the
swallow-and-re-fire surviving a trusted drop with the page's own handler on the real
DOM.

Doing this by hand on macOS has one trap worth knowing: a **fullscreen** browser window
occupies its own Space, so Finder opens in a different one and the two are never on
screen together. The drag has nowhere to land, which looks exactly like a broken guard.
Exit fullscreen (`Ctrl+Cmd+F`) and a Finder window floats above it in the same Space.

**A mixed multi-file attach (`.txt` + `.docx` together) is live-verified as well, and
is now covered by the harness** (grok e2e 58/58). It reaches a combination no
single-file case does: an Office scrub hands back a whole rebuilt `File` while a text
scrub hands back replacement *text* that has to be re-wrapped, and both branches run
in one reassembly pass — so a mix-up would put the archive's bytes under the text
file's name, or wrap the zip as text and corrupt it. The same case pins down order and
filename preservation and the all-or-nothing rule: one unscannable file blocks the
entire batch, including its clean sibling, because a partial success where the user
believes the PDF went through is worse than a refusal.

One trap that test walked into, worth knowing if you extend it: the uploaded `.docx`
is deflated, so decoding the multipart body as text and grepping for a token proves
nothing about the XML inside. It now slices the archive out and `readZip`s it, then
asserts the token is present in `word/document.xml` and the clean paragraph is
verbatim. The string-level version of that assertion passed even on an unscrubbed
archive.

Still untried on Grok: a dropped **`.docx`** (the live drop used a text file; Office is
covered via the picker) and **Firefox** generally.

## Tests

Headless (run from repo root, part of the normal suite):

```
node --experimental-strip-types --test tests/phase-gemini.test.ts       # Stage 1: gateway /redact contract
node --experimental-strip-types --test tests/phase-gemini-core.test.ts   # loop guard, fail-closed, tripwire predicate
node --experimental-strip-types --test tests/phase-gemini-response.test.ts  # assistant-reply capture (scorer + DOM walk)
node --experimental-strip-types --test tests/phase-cross-browser.test.ts    # API-shim order + generated Firefox/Safari manifests
node --experimental-strip-types --test tests/phase-chatgpt.test.ts          # host scoping, ChatGPT selectors/endpoints, openai log row
node --experimental-strip-types --test tests/phase-grok.test.ts             # host scoping, Grok selectors/endpoints, grok-web-extension log row
```

All of these are included in `npm test`. The response tests drive the real DOM walk
against a minimal DOM shim, so selector-free reply capture is covered without a
browser.

Browser e2e (Playwright, dev-only dep; drives the real `content-main.js` in
headless Chromium against a fake Gemini page + the real gateway). Needs the
browser binary once: `npx playwright install chromium`.

```
npm run test:gemini-e2e            # send path: intercept, redact, re-fire
npm run test:gemini-response-e2e   # reply capture across the three panel DOMs
npm run test:chatgpt-e2e           # ChatGPT: ProseMirror write, one send, desync -> tripwire abort
npm run test:grok-e2e              # Grok: Tiptap write, unlabeled submit button, shape-based reply capture
npm run test:firefox-e2e           # real Firefox + real add-on (needs Firefox installed)
```

Browser-free probe self-check (no Playwright, no browser, runs in ~1s):

```
npm run probe:upload-selfcheck     # validates upload-probe-console.js's own analysis
```

Proves the Stage-3 mechanics (intercept kills original, redacted text
written+read, synthetic re-submit not re-intercepted, exactly one send, zero raw
PII, gateway-down blocks send) **plus the Layer-1 self-heal** (a `?dom=changed`
scenario removes the exact selectors + adds a zero-area decoy; the heuristic
still finds the real composer and redacts). It does **not** use the real
gemini.google.com DOM or the SW/CORS plumbing end-to-end — those are the manual
steps above.

`test:chatgpt-e2e` does the same for `chatgpt.com` against
`test/e2e/fake-chatgpt.html`, whose composer mimics ProseMirror (its model follows
only real editing, so a naive `textContent` write ships stale text) and which
includes a Gemini `div.ql-editor` decoy that must never win. Details and the live
probe (`npm run probe:chatgpt`) are in [`CHATGPT_COVERAGE.md`](CHATGPT_COVERAGE.md).

`test:grok-e2e` covers `grok.com` against `test/e2e/fake-grok.html`. Two checks
there exist because Grok differs from every earlier surface, and both were
confirmed to fail without their fix rather than assumed: clicking the
**unlabeled** `button[type="submit"]` must still be intercepted (with the generic
click filter alone, nothing is sent at all — the tripwire catches the raw prompt,
so it is fail-closed but the message silently fails), and the reply must be
recovered by **shape** from class-name-free `animate-gaussian` word spans while a
suggestion chip appended after it is never logged as the answer.

## Resilience to Google DOM changes

Two layers guard against Google reshuffling the DOM (exact selectors breaking):

- **Layer 1 — self-healing finder (in-extension).** `findComposer` tries a
  Gemini-specific selector fast-path first, then falls back to the heuristic
  scorer in `composer-finder.js`. A UI change degrades to "still found by shape"
  instead of "not found → every send blocked". Security is unchanged either way:
  an unfindable composer still fails **closed**, and the tripwire still aborts raw
  PII on the wire.
- **Layer 1.5 — self-learning finder (`composer-learn.js`).** When the fast-path
  misses, candidates are chosen by the strongest signal: **focus** (the box the
  user is typing in at submit — decisive when several big editable boxes compete)
  > **learned fingerprint** (persisted from a prior focused submit, so a later
  load recalls the composer after a redesign) > heuristic shape. The fingerprint
  is shape metadata only (tag/role/aria/stable class names — **never PII**),
  stored in `chrome.storage.local` via the isolated bridge. This is the safe
  realization of "auto-identify after a Google change": it learns by evidence
  (what the user submits from), never by blindly guessing + saving a selector.
- **Layer 2 — live selector watcher (`scripts/selector-watch.mjs`).** An
  early-warning canary that opens the real Google surfaces and reports whether the
  composer is still findable, so a human is alerted **before** users hit blocked
  sends. It only detects — it does not auto-patch selectors (deliberately out of
  scope; a machine can't pick the right composer with certainty).

Self-test the watcher's probe logic headlessly (no Google login):

```
node scripts/selector-watch.mjs --self-check
```

Run it live against a **pre-logged-in** Chrome profile (cookies persist in the
profile dir — log into Google once in the window it opens, then re-run):

```
# read-only probe (no data sent to Google)
WATCH_PROFILE_DIR="$HOME/.secure-llm-gateway/watch-profile" npm run watch:selectors

# --hold: keep the browser open so you can sign in + open each Workspace
# "Ask Gemini" panel, then press Enter to probe those exact tabs
WATCH_PROFILE_DIR="$HOME/.secure-llm-gateway/watch-profile" node scripts/selector-watch.mjs --hold

# deep check: types a PII probe, sends, asserts the wire is tokenized (opt-in)
WATCH_SEND=1 WATCH_PROFILE_DIR="$HOME/.secure-llm-gateway/watch-profile" npm run watch:selectors
```

Writes a JSON report to `~/.secure-llm-gateway/selector-watch-report.json` and
exits non-zero when a surface that should always have a composer
(gemini.google.com) is missing it, or when raw PII was seen on the wire. Workspace
side panels only render a composer once the "Ask Gemini" panel is open, so a
not-found there is a warning, not a hard failure. Add more surfaces with
`WATCH_SURFACES=url1,url2`. Sample nightly cron (10:07pm local):

```
7 22 * * *  WATCH_PROFILE_DIR="$HOME/.secure-llm-gateway/watch-profile" /usr/local/bin/node /path/to/repo/scripts/selector-watch.mjs || osascript -e 'display notification "Gemini selector watch failed" with title "PII gateway"'
```
