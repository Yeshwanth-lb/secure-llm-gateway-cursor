# Gemini Web — PII Redaction Browser Extension

Best-effort, **fail-closed** PII redaction for the standalone Gemini web app
(`gemini.google.com`) **and the Google Workspace "Ask Gemini" side panel**
(Gmail, Docs, Sheets, Slides, Chat — live-verified 2026-07-21). It rewrites a
prompt through the **existing local gateway** (`POST /redact`, unchanged) before
the prompt leaves the browser.

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
| `manifest.json` | — | MV3 manifest (Chrome), scoped to `gemini.google.com` + Workspace hosts, loopback host permission only. Firefox/Safari variants are generated — see [Other browsers](#other-browsers-firefox--safari). |
| `src/browser-api.js` | isolated + background | Extension-namespace shim. Publishes `globalThis.geminiRedactBrowserApi` = `{ api, storageGet, storageSet, sendMessage }`, resolving **`chrome` before `browser`** (see [Other browsers](#other-browsers-firefox--safari)). |
| `src/loader.js` | isolated | Injects the MAIN-world ES module (MV3 content scripts can't `import`). Escalates a failed/CSP-refused load as `blocked`. |
| `src/background.js` | service worker (Chrome) / event page (Firefox, Safari) | The **only** component that fetches the gateway. Page-world fetch to `127.0.0.1` is CORS-blocked (gateway grants CORS to loopback + extension origins only); the background has `host_permissions` and is not subject to page CORS. |
| `src/content-bridge.js` | isolated | Relays config (`base`, `enabled`) from extension storage (managed > local) into MAIN, and relays redact requests MAIN→background→MAIN. No PII crosses to Google — only browser↔loopback. |
| `src/content-main.js` | MAIN | The Stage 3 core: capture-phase intercept on `document`, kill → redact → re-fire. |
| `src/interceptor-core.js` | MAIN (pure) | **Unit-tested** control logic: loop guard, synthetic-event recognition, fail-closed decision. |
| `src/composer.js` | MAIN | DOM glue: find composer (exact-selector fast-path → **heuristic self-heal** fallback), read text, write via native setter + `input` event, health check. |
| `src/composer-finder.js` | MAIN (pure) | **Unit-tested** Layer-1 scorer: ranks candidate editable boxes by shape (size, prompt-like label, near-send) so `findComposer` survives most Google DOM changes and rejects decoys (Sheets empty `role=textbox`). No DOM access. |
| `src/composer-learn.js` | MAIN (pure) | **Unit-tested** Layer-1.5 chooser: focus > learned fingerprint > heuristic. Turns "the box the user submits from" into ground truth; persists a PII-free fingerprint (via bridge → `chrome.storage.local`) to recall the composer after a redesign. No DOM access. |
| `src/response-capture.js` | MAIN | DOM glue for capturing the assistant reply on panels with **no stable selectors** (Gmail/Drive/Chat rotate class names every deploy). Anchors on the text just submitted and walks forward; feeds `response-finder.js`. Read-only — cannot affect whether a send is blocked. |
| `src/response-finder.js` | MAIN (pure) | **Unit-tested** reply scorer: ranks blocks after the user's message by shape (streamed growth, appeared-with-this-turn, non-interactive) and returns "nothing" rather than risk logging a suggestion chip. No DOM access. |
| `src/redact-client.js` | MAIN | `fetch` wrapper to the local gateway `/redact`. |
| `src/tripwire.js` | MAIN | Secondary net (**ON by default**): aborts an outgoing request to Gemini's generate endpoint whose body still contains raw PII (Luhn-checked, endpoint-scoped). DOM-independent — survives Gemini UI changes. Backup to the DOM path. |

The genuinely hard, failure-prone logic (loop guard §7 risk 2, fail-closed) is
in `interceptor-core.js` and is covered headlessly by
`../tests/phase-gemini-core.test.ts`. The DOM/selector code can only be
validated against the **live** Gemini page (Stages 2/3/5 below).

## Load it (dev)

1. Start the local gateway (default `127.0.0.1:8001`; if the installed service is already running, skip this): from repo root,
   `npm run dev` (or `node scripts/gateway-service.mjs install`).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select this `extension/` folder.
3. Open `https://gemini.google.com`. Open DevTools console; you should see
   `[gemini-redact] content script active (MAIN world)`.

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
npm run test:firefox-e2e     # real Firefox, real extension, real gateway (12 checks)
npm run probe:firefox-csp    # is the MAIN module allowed to run on live gemini.google.com?
```

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
  now also raises `blocked` if the load ever *is* refused.

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

- **Stage 2 (skeleton):** console shows the active line; on a non-Gemini tab the
  script does **not** activate. If the composer isn't found, adjust the
  selectors in `src/composer.js` (`COMPOSER_SELECTORS`).
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
  generate URL doesn't match, add its substring to `DEFAULT_GEMINI_ENDPOINTS` in
  `src/tripwire.js`. The Service-Worker blind spot is documented in the design
  doc §7 / playbook §3.7.
- **Stage 5 (health/enterprise):** break a selector in `composer.js` → confirm
  the health check fires `gemini-redact:blocked` and sending is disabled rather
  than silently leaking.

## Tests

Headless (run from repo root, part of the normal suite):

```
node --experimental-strip-types --test tests/phase-gemini.test.ts       # Stage 1: gateway /redact contract
node --experimental-strip-types --test tests/phase-gemini-core.test.ts   # loop guard, fail-closed, tripwire predicate
node --experimental-strip-types --test tests/phase-gemini-response.test.ts  # assistant-reply capture (scorer + DOM walk)
node --experimental-strip-types --test tests/phase-cross-browser.test.ts    # API-shim order + generated Firefox/Safari manifests
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
```

Proves the Stage-3 mechanics (intercept kills original, redacted text
written+read, synthetic re-submit not re-intercepted, exactly one send, zero raw
PII, gateway-down blocks send) **plus the Layer-1 self-heal** (a `?dom=changed`
scenario removes the exact selectors + adds a zero-area decoy; the heuristic
still finds the real composer and redacts). It does **not** use the real
gemini.google.com DOM or the SW/CORS plumbing end-to-end — those are the manual
steps above.

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
