# Gemini Web Extension — Rebuild Playbook

**Purpose.** Everything needed to rebuild the `gemini.google.com` PII-redaction
browser extension **from zero without hitting the walls we already hit.** Every
non-obvious blocker below cost real debugging time; each has the symptom, the
root cause, and the fix inline so a re-implementer never rediscovers it.

- **Design authority (why):** [`../scripts/gemini_imp.md`](../scripts/gemini_imp.md) (rev.2)
- **User-facing doc (how to load/verify):** [`./README.md`](./README.md)
- **This file (how to rebuild):** the ordered build + the full blocker list.

Companion memory: `gemini-extension-gotchas` in the auto-memory index.

---

## 0. Scope in one paragraph

A **DOM-level interceptor** for the standalone Gemini web app. On submit it
**kills** the user's original send, sends the prompt text to the **local
redaction gateway** (`POST /redact`, reused unchanged), writes the redacted text
back into the composer, then **independently re-fires** a fresh submit.
Redaction is **one-way** (rev.2): no reversible map, no restore-for-display — the
user's sent bubble and every reply permanently show `[REDACTED_PII_EMAIL]`-style
tokens. This deliberately deleted an entire complexity class and let the existing
gateway endpoint be reused with **no backend change**.

**It is best-effort, not airtight.** It sits *beside* the request path, not *in*
it (unlike the Claude Code loopback gateway). Built **fail-closed** and
health-checked so a missed path / lost race / UI change blocks the send rather
than leaking silently.

---

## 1. Why a browser extension at all (the first wall)

**Wall:** the Claude Desktop / Cursor approach — point the client at a loopback
gateway — **cannot work for Gemini web.** The browser sends prompts from
**Google's servers**, so there is no on-machine request path to occupy. And MV3
**forbids** rewriting request bodies (`webRequest` is read-only for the body).

**Fix / only option:** intercept at the **DOM level** inside the page — read the
composer, redact, re-submit. That constraint drives the entire architecture
below.

---

## 2. The four-world model (get this right first)

MV3 splits your code across execution contexts that **cannot share variables**.
Mixing up which world can do what is the single biggest source of "why is this
`undefined`" churn. Memorize this table:

| World | Can see Gemini's page JS / composer? | Can call `chrome.*`? | Can fetch the gateway? |
|-------|:---:|:---:|:---:|
| **MAIN** (page world) | ✅ yes | ❌ no | ❌ no (CORS — see §3) |
| **ISOLATED** (content script) | DOM only, not page JS vars | ✅ yes | ❌ no (CORS — see §3) |
| **Service Worker** (background) | ❌ no | ✅ yes | ✅ **yes** (host_permissions, not page-CORS) |

Consequences that dictate the file layout:

- Interception must run in **MAIN** (needs Gemini's own composer + events).
- MAIN can't reach `chrome.storage` or `chrome.runtime` → needs an **ISOLATED**
  bridge, reached via DOM `CustomEvent` (the only channel both share).
- Neither page context may fetch the gateway → the fetch lives in the **SW**.

**Data flow (redact one prompt):**
```
MAIN (content-main) --CustomEvent--> ISOLATED (content-bridge)
   --chrome.runtime.sendMessage--> SW (background) --fetch--> 127.0.0.1 gateway
   --response back up the same chain-->
```
Raw prompt text travels **only** browser → 127.0.0.1 → browser (same machine).
It never goes to Google and never crosses to a remote origin.

---

## 3. The blocker list (the actual point of this doc)

Every item here is a wall we hit. If you rebuild and skip one, you will hit it too.

### 3.1 MV3 content scripts can't `import` ES modules
- **Symptom:** `Cannot use import statement outside a module` in the content script.
- **Root cause:** MV3 injects content scripts as classic scripts; no ESM.
- **Fix:** author the core as ES modules (keeps them unit-testable with
  `node --test`), and have an **isolated-world `loader.js`** inject a
  `<script type="module" src="chrome.runtime.getURL('src/content-main.js')">`
  into the page. Its relative imports then resolve normally and it runs in MAIN.
  List every importable module in `web_accessible_resources`. **Zero bundler.**

### 3.2 Gateway CORS blocks a page-world fetch (the CORS wall)
- **Symptom:** `/redact` fetch from the page fails; extension fails closed on
  *every* message even though the gateway is up.
- **Root cause:** the gateway grants CORS to **loopback origins only**
  (`src/server.ts` `corsHeaders`), and the `/redact` **POST** response carries no
  `Access-Control-Allow-Origin` at all (only the OPTIONS preflight did). A fetch
  from `gemini.google.com` (or any page origin) is browser-blocked.
- **Fix (two parts):**
  1. Move the fetch to the **background service worker**. It has
     `host_permissions` for `127.0.0.1` and its fetch is extension-privileged,
     **not subject to page CORS.** Page never fetches the gateway.
  2. The SW's own origin is `chrome-extension://<id>`, which the gateway *also*
     rejected → the gateway now allows **extension origins on `/detect`,
     `/redact`, `/log-turn` only** (`src/server.ts` `isExtensionOrigin`). Foreign
     http(s) origins still blocked; those hook endpoints expose no stored data.

### 3.3 Quill async model-sync race — **leaked a real email** (the worst one)
- **Symptom:** DOM shows the token, but the request that leaves still contains the
  **raw** value. Observed live with a real email.
- **Root cause:** Gemini's composer is **Quill**. Quill sends from its own
  internal model (a **Delta**), not from `textContent`. It syncs the Delta from
  DOM mutations **asynchronously**. A bare `el.textContent = redacted` updates the
  DOM but not the Delta; if you re-fire the submit synchronously, Quill grabs the
  **stale (raw)** Delta and sends it.
- **Fix (two parts, both required):**
  1. Write via the **native input pipeline** the editor listens to, not
     `textContent`: `focus()` → select-all range → `document.execCommand(
     "insertText", false, redacted)`. (`execCommand` is deprecated but remains the
     most reliable cross-framework contenteditable edit.) For a `<textarea>`
     fallback, use the **native value setter** + a real `InputEvent`.
  2. **Yield a macrotask before re-firing:** `await new Promise(r =>
     setTimeout(r, 120))` so the editor's MutationObserver absorbs the change into
     its Delta first. Without the delay the race still leaks intermittently.
- **This is `composer.writeText` + the `120ms` sleep in `content-main.js`.** Do
  not "simplify" either away.

### 3.4 The kill-and-re-fire loop (you can't pause a DOM event across async)
- **Symptom:** either the original raw text still sends, or an infinite
  intercept→re-fire→intercept loop / double redaction.
- **Root cause:** you cannot `await` the gateway inside an event handler and then
  resume the *same* event. You must fully **kill** it and fire a **new** one — but
  your own new one must not be re-caught.
- **Fix:**
  1. Kill hard: `preventDefault()` + `stopImmediatePropagation()` on a
     **`document`-level CAPTURE-phase** listener (runs before Gemini's handler,
     wherever it's attached).
  2. **Loop guard** (`interceptor-core.js`): ignore a submit when any of —
     `resubmitting` flag is held during our re-fire, the event carries our
     `SYNTHETIC` symbol tag, or `event.isTrusted === false`. Belt **and**
     suspenders: synthetic events are untrusted *and* tagged *and* fired inside
     the held flag.

### 3.5 Synthetic submit may be ignored (`isTrusted:false`)
- **Symptom:** re-fired submit does nothing; message never sends after redaction.
- **Root cause:** framework handlers sometimes ignore untrusted events.
- **Fix:** prefer **clicking the real Send button** (`findSendButton`) over
  dispatching a synthetic Enter; fall back to a tagged `keydown` Enter. **Live
  proof required** — this can only be validated against the real page (it did work
  live 2026-07-20; the synthetic click triggers Gemini's Angular send).

### 3.6 Fail-closed must be the default everywhere
- **Rule:** any uncertainty → **block the send**, never let raw through.
  - Gateway unreachable / non-200 / timeout → `decideSubmission` returns
    `{action:"block"}` (see `interceptor-core.js`); never fall back to raw on `ok`.
  - Composer not found → `preventDefault` + block + notify (`selectors-broken`).
  - Loader injection fails → fire `gemini-redact:blocked`.
  - Bridge/SW dead (`chrome.runtime.lastError`, undefined result) → `{ok:false}`.

### 3.7 Tripwire false-positived on Gemini's own telemetry — **fixed + ON by default**
- **Symptom (original):** the global `fetch`/`XHR` wrapper aborted Gemini's *own*
  analytics traffic (and risked the real chat send).
- **Root cause:** the loose card pattern (13–19 digits, **no Luhn**) matched
  Google's analytics IDs/tokens, and the wrapper inspected **all** requests.
- **Fix (Phase G4, shipped ON):** two changes made it safe:
  1. **Endpoint scoping** — `shouldInspectUrl(url)` only inspects requests whose
     URL matches `DEFAULT_GEMINI_ENDPOINTS` (`StreamGenerate`, `BardFrontendService`,
     `assistant.lamda`, `/BardChatUi/`, `batchexecute`). All other traffic
     (telemetry, images, analytics) passes untouched.
  2. **Luhn** — a digit run is a card only if `luhnValid` passes (mirrors
     `src/redaction.ts`), killing analytics-ID matches.
- **State:** ON by default. `config.tripwire:false` disables; `tripwireEndpoints`
  (managed/local storage) tunes the list. It **cannot rewrite** the body (MV3),
  only **block** — so on a broken DOM path the failure mode is "send blocked",
  never "raw leaked". This is the DOM-independent net that survives Gemini UI
  changes. **The endpoint list is live-tunable like the selectors — confirm it
  against the real Network tab; if the generate URL drifts, add its substring.**
- **Still true — SW blind spot:** requests from the background service worker are
  invisible to this page-world wrapper. Harmless here: our own `/redact` +
  `/log-turn` calls go via the SW, so they can never self-trip; and DOM
  interception, not the tripwire, is the primary coverage.

### 3.8 Word-boundary rule limit (known, documented, not a bug to "fix" here)
- `\b`-anchored rules (SSN/PHONE/CARD/PAN/AADHAAR/IPV4) miss PII **glued to
  adjacent chars** with no separator (`SSN078051120`, or a multi-line paste whose
  newlines Gemini strips → `0147India`). Goes out **raw**. Rare in prose. See
  `gemini_imp.md` §7.11. This lives in the gateway rules, not the extension.

### 3.11 Google Workspace side panel — the disabled-decoy send button (live 2026-07-21)
Extending to the Workspace "Ask Gemini" panel (Gmail/Docs/Sheets/Slides/Chat) was
**additive** (manifest hosts + one composer selector) EXCEPT for the send trigger.
Findings, each cost real debugging:
- **Composer is top-level DOM, not shadow/iframe.** A deep shadow-piercing probe
  confirmed `OUR SELECTOR @top: true`, `shadow hosts: 0`. Selector
  `div[contenteditable="true"][aria-label*="Ask Gemini" i]` matches (contains-match
  catches Chat's `"Ask Gemini..."`). It's Google's **`appsElements`** component, not Quill.
- **Two `aria="Submit"` buttons — a DISABLED decoy + the real ENABLED one.**
  `document.querySelector('button[aria-label="Submit"]')` returned the **disabled**
  decoy; clicking a disabled button does nothing → send silently stuck, redacted
  text just sat in the box. **Fix:** `fireSubmit` must pick a candidate that is
  BOTH `!disabled` AND visible (`offsetParent !== null`), scoped to the composer's
  container first.
- **Gm3 Material buttons ignore a bare synthetic `click`.** A single
  `new MouseEvent("click")` (which worked on gemini.google.com) does nothing here.
  **Fix:** dispatch the full sequence `pointerdown → mousedown → pointerup →
  mouseup → click` (each `markSynthetic`). Verified live: the enabled button then
  sends. This is a **superset** of the old single-click, so gemini web still works.
- **Redaction proven on the wire.** Docs `streamGenerate` payload contained
  `"hello test [REDACTED_PII_EMAIL]"` — token, zero raw. Not just the bubble.
- **Endpoint differs from gemini web.** Workspace uses lowercase `streamGenerate`
  on the `appsgenaiservice` host (gemini web uses `StreamGenerate`/`BardFrontendService`).
  `includes` is case-sensitive → both listed in `DEFAULT_GEMINI_ENDPOINTS` so the
  tripwire covers Workspace too.
- All five apps share the **same panel + endpoint + code path** → one fix covers them.
- **Stray-textbox selector-order trap (Sheets, live 2026-07-21).** Sheets renders
  extra **empty** `div[contenteditable="true"][role="textbox"]` elements in the DOM.
  `findComposer` tries `COMPOSER_SELECTORS` in order; the generic
  `[role="textbox"]` selector matched an **empty** stray box **before** the
  Workspace `aria*="Ask Gemini"` selector → `readText` returned `""` →
  `onSubmitEvent` bailed on "empty text" → the send went out **UNREDACTED**.
  Symptom was subtle: interception fired (`submit seen`), composer "found", but
  `readText len=0`. **Fix:** order the specific `aria*="Ask Gemini"` selector
  **before** the generic `role=textbox`/`textarea` catch-alls in
  `composer.js` (Quill stays first, so gemini.google.com is unaffected). Lesson:
  a more-specific composer selector must always precede generic contenteditable
  catch-alls, or an empty decoy silently defeats redaction. `content-main.js` has
  `CONFIG.debug` tracing in `onSubmitEvent` (off by default) that pinpointed this.

### 3.9 Port is 8001, not 8000
- The gateway for extension work runs on **8001**. Extension defaults +
  `host_permissions` list both `127.0.0.1:8001` (primary) and `:8000`. If a fetch
  silently fails-closed, check the port first.

### 3.10 New-turn mispairing in the log
- **Symptom:** logged turn pairs your prompt with the *previous* reply.
- **Root cause:** reading "latest response" immediately grabs the prior turn's node.
- **Fix:** snapshot `responseCount()` **before** re-firing; only capture once a
  node past that baseline appears; debounce 2.5s of quiet to detect stream end;
  hard 30s cap so a turn always logs (prompt-only if capture fails). Never log a
  stale pairing — a wrong pairing in an audit log is worse than a missing one.

---

## 4. Build order (files, in dependency order)

Author bottom-up so each layer is testable before the next.

1. **`src/interceptor-core.js`** (MAIN, pure) — loop guard
   (`createInterceptor`: `shouldIntercept`, `markSynthetic`, `runResubmit`) +
   `decideSubmission` (fail-closed). **No DOM, no fetch.** Unit-test headlessly
   first (`tests/phase-gemini-core.test.ts`).
2. **`src/redact-client.js`** (MAIN) — `fetch` wrappers `redact()` (sends
   `audit:false`) and `logTurn()`. Never throws; `{ok:false}` on any failure.
   *(In the shipped design the SW imports these; MAIN reaches them via the bridge.)*
3. **`src/composer.js`** (MAIN) — the selector-fragile DOM: `findComposer`,
   `readText`, `writeText` (§3.3), `findSendButton`, `getModel`,
   `readLatestResponse`/`responseCount`, `selectorsHealthy`. **Centralize every
   selector here** — a UI change is then a one-line fix and the health check has
   one place to verify.
4. **`src/tripwire.js`** (MAIN) — DOM-independent backup net; keep predicates
   (`bodyLooksRaw`, `luhnValid`, `shouldInspectUrl`) pure/tested. **Must be
   Luhn-checked + endpoint-scoped** (§3.7) — then ship **ON** by default.
5. **`src/content-main.js`** (MAIN) — the glue: capture-phase listeners on
   `document` for Enter + Send click; the kill→redact→write→yield→re-fire flow;
   `captureAndLogTurn`; 15s selector health poll.
6. **`src/content-bridge.js`** (ISOLATED) — relay config `chrome.storage`
   (managed > local) → MAIN via `CustomEvent`; relay redact/log requests
   MAIN → SW → MAIN.
7. **`src/loader.js`** (ISOLATED) — inject the MAIN-world module (§3.1).
8. **`src/background.js`** (SW) — the **only** gateway fetch; dispatch on
   `msg.type` (`redact` / `logTurn`); load config from managed/local storage.
9. **`manifest.json`** — see §5.

---

## 5. manifest.json — the exact shape (and why)

```jsonc
{
  "manifest_version": 3,
  "minimum_chrome_version": "111",          // MAIN-world content scripts
  "permissions": ["storage"],               // config only; no broad perms
  "host_permissions": ["http://127.0.0.1:8001/*", "http://127.0.0.1:8000/*"],
  "background": { "service_worker": "src/background.js", "type": "module" },
  "content_scripts": [{
    "matches": ["https://gemini.google.com/*"],
    "js": ["src/content-bridge.js", "src/loader.js"],  // ISOLATED world
    "run_at": "document_start",             // beat Gemini's own handlers
    "world": "ISOLATED"
  }],
  "web_accessible_resources": [{
    "resources": ["src/content-main.js","src/interceptor-core.js",
                  "src/composer.js","src/tripwire.js"],  // all MAIN imports
    "matches": ["https://gemini.google.com/*"]
  }]
}
```
- **`host_permissions` loopback only** — this is what lets the SW fetch the
  gateway without page CORS (§3.2). It is *not* a network-access broadening for
  the page.
- **`document_start`** — register the capture listener before Gemini wires its own.
- **Every MAIN import must be in `web_accessible_resources`** or the module load
  404s and you fail closed (§3.1).

---

## 6. Gateway contract (backend, reused UNCHANGED)

The extension depends only on these loopback endpoints (`src/server.ts`). No
extension-specific backend was added.

| Endpoint | Method | Body | Returns | Notes |
|----------|--------|------|---------|-------|
| `/redact` | POST | `{text, source, audit:false}` | `{redacted, piiDetected, matched}` | Send-time redaction. `audit:false` → **no** log row (avoids a duplicate; the turn is logged once via `/log-turn`). |
| `/log-turn` | POST | `{prompt, response, model, source}` | `{ok}` | Logs **one** `CHAT` row per turn: `provider:gemini` + model + clean view. Send the **raw** prompt — gateway redacts server-side before storing, so the inspector's PII flag/counts are accurate while only redacted text persists. |
| `/detect` | POST | `{text}` | `{piiDetected,...}` | Detect-only (used by Cursor hooks; not the Gemini path). |
| `/healthz` | GET | — | install/health | Selector-health / doctor. |

**CORS:** all three hook endpoints (`/detect`, `/redact`, `/log-turn`) accept a
`chrome-extension://` origin via `isExtensionOrigin` (§3.2). Everything else stays
loopback-origin gated. **Do not** widen CORS beyond these three.

---

## 7. Live-verified selectors (2026-07-20 — starting point, expect drift)

Centralized in `composer.js`. These hit the real DOM on first try 2026-07-20;
re-tune against the live page if interception breaks.

- **Composer:** `div.ql-editor[contenteditable="true"]` (Quill) — matched live.
  Fallbacks: `rich-textarea .ql-editor`, `div[contenteditable][role="textbox"]`,
  `textarea[aria-label]`.
- **Send button:** `button.send-button` → `button[aria-label*="Send" i]` → …
- **Model label:** `[data-test-id="bard-mode-menu-button"]` → `.logo-pill-label-container`
  → header tier-word scan (`flash|pro|ultra|nano`) → `"gemini"`.
- **Response:** `message-content .markdown` → `.model-response-text .markdown` → …

---

## 8. Verify (do these in order)

**Headless (part of `npm test`):**
```
node --experimental-strip-types --test tests/phase-gemini.test.ts        # /redact contract
node --experimental-strip-types --test tests/phase-gemini-core.test.ts    # loop guard, fail-closed, tripwire predicate
npm run test:gemini-e2e                                                    # Playwright: real content-main vs fake page + real gateway
```
e2e (8/8) proves Stage-3 mechanics: capture-phase intercept kills the original,
redacted text written+read, synthetic re-submit **not** re-intercepted (exactly
**one** gateway call + **one** send), zero raw PII, gateway-down blocks. It does
**not** cover the real gemini.google.com selectors or the SW/CORS plumbing — those
are manual.

**Browser-gated (real site, not `npm test`):**
1. Start gateway (`npm run dev`, `127.0.0.1:8001`).
2. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.
3. Open `gemini.google.com`; console shows
   `[gemini-redact] content script active (MAIN world)`.
4. **The definitive proof:** paste `pii-sample.txt` (regen with
   `node scripts/gen-pii-sample.mjs` — builds one valid sample per rule, verifies
   each trips against the live gateway). Hit Enter. In the **Network** tab confirm
   the outgoing request contains only `[REDACTED_PII_*]` tokens and **zero** raw
   PII, and there is exactly **one** request (no loop). Repeat via the Send button.
5. Stop the gateway → confirm the send is **blocked**, not sent raw.
6. Break a selector in `composer.js` → confirm health check fires
   `gemini-redact:blocked` and sending disables (doesn't silently leak).

---

## 9. Porting to Safari / Firefox

Chrome-only today (`chrome.*` APIs, SW background model, MAIN-world inject).

- **Firefox** (closer): uses `browser.*`; background is `background.scripts`, not
  `service_worker`. Hand-roll a shim (`const api = globalThis.browser ?? globalThis.chrome`)
  — no polyfill dependency (zero-dep constraint). Re-verify MAIN-world inject.
- **Safari** (more work): extension must ship inside a native macOS/iOS app.
  Convert with `xcrun safari-web-extension-converter extension/` → Xcode → sign →
  load. Re-verify MAIN-world support (flakier across Safari versions) and the SW
  background behavior. Untested — treat as new work, not a config flip.

---

## 10. Invariants — do not regress

- Raw prompt text goes **only** browser ↔ 127.0.0.1. Never to Google, never to a
  remote origin, never persisted raw (gateway stores redacted only).
- **Fail closed** on every uncertainty (§3.6). Erroring beats leaking.
- **One-way** redaction — no map, no restore. The gateway endpoint stays unchanged.
- Keep the hard logic **pure and unit-tested** (`interceptor-core.js`); keep the
  fragile DOM logic **centralized** (`composer.js`) and health-checked.
- Never widen gateway CORS beyond the three hook endpoints for extension origins.
- Keep the `writeText` native-pipeline write **and** the pre-refire yield (§3.3).
