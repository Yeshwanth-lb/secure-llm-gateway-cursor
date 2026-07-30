# Cross-browser port — Firefox + Safari

> **For the implementing agent (Cursor):** this is the spec. Implement it against the
> existing Chrome MV3 extension in `extension/`. Read `extension/README.md`,
> `scripts/gemini_imp.md`, and the "Gemini-web extension (Phase G)" sections of the
> repo-root `CLAUDE.md` for full architecture and history before writing code.
> Work incrementally, keep every existing test green, and **surface anything that
> can't be matched on a browser rather than faking it.**

---

## 1. Goal

Make the extension run on **Firefox** and **Safari** in addition to Chrome, with the
**same behavior and the same security model**. Do NOT change what the extension does or
touch the redaction logic. Port only the browser-specific plumbing.

---

## 2. What the extension does (behavior to preserve exactly)

On a Gemini surface (gemini.google.com, or the "Ask Gemini" side panel in Gmail / Docs /
Sheets / Slides / Drive / Chat):

1. Intercept the user's submit in the **capture phase** and fully kill the original event
   (`preventDefault` + `stopImmediatePropagation`) — see `src/interceptor-core.js`,
   `src/content-main.js`.
2. Send the prompt text to the **local gateway** `http://127.0.0.1:8001` (`POST /redact`)
   and get back a redacted version.
3. Write the redacted text into the composer (native setter + `execCommand("insertText")`
   + real `input` event, then a short yield) so the page framework's internal model syncs.
4. Re-fire a **synthetic** submit, loop-guarded so our own event isn't re-intercepted.
5. Watch the DOM until the model's reply settles, then `POST /log-turn` with the raw
   prompt + captured reply (the gateway redacts both server-side and stores redacted only).

A DOM-independent **tripwire** (`src/tripwire.js`) also fail-closes: it aborts any outbound
request to a Gemini endpoint that still carries raw PII. **All gateway fetches happen ONLY
in the background service worker** — never from the page (page-origin fetches to the
gateway are CORS/blocked).

Security invariants that MUST hold on every browser:
- Raw PII is never sent to Gemini (redacted on the wire) and never persisted.
- If the composer can't be found or the gateway is unreachable, the send **fails closed**
  (blocked), it does not leak.
- The gateway is reached **only** from the background, over loopback.

---

## 3. Architecture (current Chrome MV3)

Data flow for one turn:

```
page (MAIN world)  content-main.js
      │  window.dispatchEvent(CustomEvent "gemini-redact:redact-request")
      ▼
content-bridge.js  (ISOLATED world — has extension APIs)
      │  chrome.runtime.sendMessage({type:"redact", text})
      ▼
background.js  (service worker — the ONLY place allowed to fetch the gateway)
      │  fetch http://127.0.0.1:8001/redact   (POST /log-turn similarly)
      ▼  result flows back the same path in reverse
```

Why the bridge exists: the MAIN-world script can see the page but has **no** `chrome.*`
APIs; the ISOLATED content script has `chrome.*` but is a separate world. The bridge
(ISOLATED) relays config (`chrome.storage`) and messages (`chrome.runtime`) between them.

Why the SW does the fetch: the gateway grants CORS to loopback + extension origins only;
a page-origin (`gemini.google.com`) fetch is blocked, and the background fetch is
extension-privileged.

MAIN-world injection: content scripts can't `import` ES modules, so `src/loader.js`
(ISOLATED) injects `src/content-main.js` as a MAIN-world ES module via a `<script>` tag
pointing at a `web_accessible_resources` URL.

### File inventory

**Browser-AGNOSTIC — keep the logic unchanged** (pure or DOM-only; no extension APIs
except via the shim you'll add). These have unit/e2e tests that must keep passing:

| File | Role |
|---|---|
| `src/content-main.js` | MAIN-world orchestrator (intercept → redact → re-fire → capture). Uses `window` CustomEvents only. |
| `src/interceptor-core.js` | Pure loop-guard / intercept decision. |
| `src/composer.js` | Composer + send-button + response selectors; `isGenerating`, `readLatestResponse`. |
| `src/composer-finder.js` | Pure composer scorer (self-heal). |
| `src/composer-learn.js` | Pure focus/fingerprint learner. |
| `src/response-capture.js` | DOM glue for shape-based reply capture. |
| `src/response-finder.js` | Pure reply ranking + `looksLikeMetadata`. |
| `src/tripwire.js` | Fail-closed outbound-request net. |
| `src/redact-client.js` | `fetch` wrapper for `/redact` + `/log-turn` (uses `fetch`, not `chrome.*`). |

**Browser-SPECIFIC — port these:**

| File | Extension APIs used |
|---|---|
| `manifest.json` | MV3 manifest (background SW, content_scripts, host_permissions, web_accessible_resources). |
| `src/background.js` | `chrome.runtime.onMessage`, `chrome.storage`. |
| `src/content-bridge.js` | `chrome.storage`, `chrome.storage.onChanged`, `chrome.runtime.sendMessage`. |
| `src/loader.js` | `chrome.runtime.getURL` (MAIN-world injection). |

---

## 4. Implementation plan

Do **Firefox first** (closest to Chrome), verify live, then **Safari**.

### Step 1 — API namespace shim
Add `src/browser-api.js`:
```js
// Firefox & Safari expose `browser`; Chrome/Edge expose `chrome`. Both accept the
// callback-style calls this extension already uses, so no promise wrapping needed.
export const api = globalThis.browser ?? globalThis.chrome;
```
Replace `chrome.*` with `api.*` in `background.js`, `content-bridge.js`, `loader.js`.
**Do NOT** add the `webextension-polyfill` dependency — this repo is zero-dependency; the
shim above is enough. (`content-bridge.js` / `loader.js` are classic content scripts, not
modules — inject the shim as an extra content-script file loaded before them, or inline the
one-liner; do not convert them to ES modules.)

### Step 2 — Per-browser manifests
Keep `manifest.json` as the Chrome manifest. Produce Firefox + Safari variants — either
`manifest.firefox.json` / `manifest.safari.json` plus a copy step in `package.json`
scripts, or a small generator. Differences below.

### Step 3 — Firefox: load, verify loopback fetch + live redaction on gemini.google.com
Use `web-ext run` (or `about:debugging` → Load Temporary Add-on). Confirm a real send is
redacted on the wire and a turn is logged.

### Step 4 — Safari: convert, verify (or document the blocker)
`xcrun safari-web-extension-converter extension/` to generate the Xcode wrapper; build and
run; test the loopback fetch **early** (highest risk — see §5).

### Step 5 — Update docs + ledger
README "Firefox" and "Safari" sections; a Phase-G ledger note in `CLAUDE.md` recording the
port and any per-browser limitations found.

---

## 5. Critical gotchas (this is where the port breaks — verify each)

1. **Loopback fetch from the background.** The whole design depends on the background
   reaching `http://127.0.0.1:8001`.
   - **Chrome:** needed a Private Network Access preflight; the gateway already answers
     `Access-Control-Allow-Private-Network: true`.
   - **Firefox:** generally works with `http://127.0.0.1:8001/*` in `host_permissions`.
     Firefox MV3 host permissions may be optional — ensure the fetch isn't silently blocked;
     request the permission if needed.
   - **Safari — THE RISK:** Safari restricts local-network access from extensions. Test
     `POST /redact` from the Safari background **first**. If it's blocked, **document it as
     a Safari limitation** — do NOT move the fetch into the page (that reintroduces the CORS
     block the SW exists to avoid) and do NOT weaken the fail-closed behavior. "Firefox yes,
     Safari blocked" is an acceptable, honest outcome; a silent leak is not.
   - The gateway CORS already allows `chrome-extension://`, `moz-extension://`, and
     `safari-web-extension://` origins on the hook endpoints (`src/server.ts`
     `isExtensionOrigin`). If a browser presents a different origin string, **report the
     exact string** — do not edit the gateway yourself.

2. **MAIN-world injection.** `loader.js` injects `content-main.js` as a MAIN-world module
   via a `web_accessible_resources` URL + `<script>` tag. Confirm this works on Firefox and
   Safari. Firefox 128+ and Chrome support `world: "MAIN"` content scripts natively — you
   may use that where available, but the `<script>`-injection fallback MUST remain for
   Safari / older Firefox. `web_accessible_resources` must stay in the MV3 object form
   (`{ resources, matches }`).

3. **MAIN-world model sync (highest correctness risk).** `composer.writeText` uses a native
   setter + `execCommand("insertText")` + a real `input` event, then a ~120ms yield before
   re-firing, because the page's editor (Quill / Angular / Gm3) reads from an internal model
   that syncs from the DOM **asynchronously**. Re-verify on Firefox and Safari that the
   **redacted** text (not the raw text) is what actually gets sent — a regression here is a
   silent PII leak.

4. **`all_frames` + frame arming.** `content_scripts` use `all_frames: true` so the script
   reaches the cross-origin `chat.google.com` panel iframe (Gmail/Drive host the composer
   there). `content-main.js` only arms in the top frame or a `chat.google.com` subframe
   (`isArmableFrame`) and only fails closed in a frame that has actually seen a composer
   (`sawComposer`). Confirm subframe injection + arming behave the same on each browser.

5. **Storage + messaging.** `api.storage.local` / `api.storage.managed` and
   `api.runtime.sendMessage` work the same via the shim on Firefox. On Safari,
   `storage.managed` may be unavailable — fall back to `local` gracefully (the code already
   treats `managed` as optional; keep that).

6. **Background type.** Chrome MV3 uses `background.service_worker`. Firefox 121+ supports
   `service_worker`, but for widest coverage also provide a `background.scripts` event-page
   fallback in the Firefox manifest. Safari supports the MV3 SW via the converter.

---

## 6. Deliverables

- `src/browser-api.js` shim; `background.js` / `content-bridge.js` / `loader.js` using `api.*`.
- Firefox manifest (+ `browser_specific_settings.gecko.id`, `strict_min_version`, background
  fallback) and Safari manifest, with a build/copy step wired into `package.json`.
- `extension/README.md`: "Firefox" and "Safari" load/build/test sections (Safari includes
  the `xcrun safari-web-extension-converter` step + signing/notarization note).
- A Phase-G ledger entry in `CLAUDE.md` recording the port + any browser-specific limits
  (especially the Safari loopback result).
- **All existing tests still green:** `npm test`, `npm run test:gemini-e2e`,
  `npm run test:gemini-response-e2e`.

## 7. Acceptance criteria

- Firefox: a real prompt with PII typed on gemini.google.com leaves as a redacted token on
  the wire, and the turn appears in the gateway Traffic Inspector (`http://127.0.0.1:8001`).
- Safari: the same, OR a clear, documented statement of exactly what Safari blocks and why,
  with the fail-closed behavior intact (no silent leak).
- Chrome behavior unchanged; all three test suites pass.
- No new runtime dependency added. No change to `src/` (the gateway) or to the redaction
  logic. If a gateway change is genuinely required, **STOP and list what's needed** instead
  of editing it.

## 8. Do NOT

- Do not move the gateway fetch out of the background into the page.
- Do not add `webextension-polyfill` or any runtime dependency.
- Do not change the redaction rules, the intercept/fail-closed logic, or the tripwire.
- Do not commit a large generated Xcode project; keep the Safari wrapper out of the repo or
  minimal, and document how to regenerate it.
