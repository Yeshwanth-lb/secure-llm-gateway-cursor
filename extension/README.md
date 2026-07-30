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
| `manifest.json` | — | MV3 manifest, scoped to `gemini.google.com`, loopback host permission only. |
| `src/loader.js` | isolated | Injects the MAIN-world ES module (MV3 content scripts can't `import`). |
| `src/background.js` | service worker | The **only** component that fetches the gateway. Page-world fetch to `127.0.0.1` is CORS-blocked (gateway grants CORS to loopback origins only); the SW has `host_permissions` and is not subject to page CORS. |
| `src/content-bridge.js` | isolated | Relays config (`base`, `enabled`) from `chrome.storage` (managed > local) into MAIN, and relays redact requests MAIN→SW→MAIN. No PII crosses to Google — only browser↔loopback. |
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
```

All three are included in `npm test`. The response tests drive the real DOM walk
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
