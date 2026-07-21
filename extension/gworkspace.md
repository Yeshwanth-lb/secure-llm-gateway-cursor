# Claude Code Task — Extend Gemini PII Redaction Extension to Google Workspace Apps

## Context

I have a working Chrome MV3 extension that redacts PII in `gemini.google.com` by intercepting the prompt at the DOM level, sending it to a local redaction gateway (`127.0.0.1:8001`), writing the redacted text back into the composer, and re-firing the submit. It is fail-closed and works reliably today.

I want to **extend** it to also work in Google Workspace apps that have the Gemini side panel — **without breaking or changing the existing Gemini web behavior in any way.**

## Investigation already done (do not re-investigate)

I manually confirmed via Chrome DevTools that the Gemini input box in all these Workspace apps sits **directly in the main page DOM** (NOT in an iframe — I verified this by switching DevTools context into every iframe and finding nothing; the input is in the top-level document). The input element in every app is:

```html
<div contenteditable="true" role="combobox" aria-label="Ask Gemini" ...>
```

Confirmed apps and their input elements:

| App | URL pattern | aria-label value |
|-----|-------------|------------------|
| Gmail | `mail.google.com` | `Ask Gemini` |
| Docs | `docs.google.com/document` | `Ask Gemini` |
| Sheets | `docs.google.com/spreadsheets` | `Ask Gemini` |
| Slides | `docs.google.com/presentation` | `Ask Gemini` |
| Drive | `drive.google.com` | `Ask Gemini` |
| Chat | `chat.google.com` | `Ask Gemini...` (note the trailing dots) |

Because Docs, Sheets, and Slides all live on `docs.google.com`, one host entry covers all three. Chat uses `aria-label="Ask Gemini..."` (with trailing ellipsis) so an exact-match selector will miss it — must use a "contains" match.

The Workspace input is Google's own `appsElements` rich-text component, NOT Quill. So the Quill-specific Delta race may or may not apply — flag this for me to test live (see "What NOT to do" below).

## Hard constraints — DO NOT BREAK THE WORKING EXTENSION

1. **Do NOT modify any existing logic** in `interceptor-core.js`, `redact-client.js`, `tripwire.js`, `content-main.js`, `content-bridge.js`, `loader.js`, or `background.js`. The only files that should change are `manifest.json` and `composer.js`.
2. **Only ADD, never remove or reorder** existing selectors or match patterns. Gemini web must keep matching its own existing Quill selector first.
3. **Preserve fail-closed behavior everywhere.** No new code path may fall back to sending raw text.
4. Keep the zero-dependency, zero-bundler constraint. Plain ES modules only.

## Change 1 — `manifest.json`

Add the Workspace hosts to BOTH the `content_scripts[0].matches` array AND the `web_accessible_resources[0].matches` array. Keep `https://gemini.google.com/*` as the first entry in both. Final arrays should be:

```json
[
  "https://gemini.google.com/*",
  "https://mail.google.com/*",
  "https://docs.google.com/*",
  "https://drive.google.com/*",
  "https://chat.google.com/*"
]
```

Do not change `run_at`, `world`, `host_permissions`, `background`, or any other manifest field.

## Change 2 — `composer.js`

In the `COMPOSER_SELECTORS` array, APPEND one new selector at the END of the list (so Gemini web's existing Quill selectors are still matched first for that site):

```javascript
'div[contenteditable="true"][aria-label*="Ask Gemini" i]',  // Workspace apps (Gmail/Docs/Sheets/Slides/Drive/Chat)
```

Use `aria-label*=` (contains) with the `i` (case-insensitive) flag so it matches both `"Ask Gemini"` and `"Ask Gemini..."`.

Do not change `findComposer`, `readText`, `writeText`, `findSendButton`, or any other function in this file. The existing `writeText` (execCommand insertText + native input pipeline) should work for the Workspace contenteditable too, but see the note below.

## What NOT to do (leave these for me to test live)

- Do NOT change the 120ms yield or the `writeText` implementation yet. The Workspace component is `appsElements`, not Quill. I will test live whether the redacted text sticks and sends correctly. If it doesn't, we will handle that as a separate, targeted change — do not preemptively rewrite `writeText`.
- Do NOT add Meet (`meet.google.com`), Vids, NotebookLM, or AppSheet. Those use different UIs (no promptable side-panel input) and are out of scope for this change.
- Do NOT touch the send-button selectors — I need to verify the Workspace send button separately.

## After making the changes

1. List exactly which lines changed in `manifest.json` and `composer.js`, and confirm no other files were touched.
2. Remind me of the manual test sequence:
   - Load unpacked, start gateway on `127.0.0.1:8001`
   - Test `gemini.google.com` FIRST — confirm it still redacts exactly as before (regression check)
   - Then test Gmail → type an email address in Ask Gemini, hit send, confirm only `[REDACTED_PII_*]` leaves in the Network tab
   - Repeat for Sheets, Docs, Slides, Drive, Chat
   - Confirm fail-closed: stop the gateway, confirm sends are blocked in all apps
3. Flag the two things I still need to verify live: (a) does the `appsElements` composer need a different yield/write approach than Quill, and (b) does the Workspace send button get found correctly by the existing `findSendButton`.

## Summary

Two files change. Additive only. Gemini web untouched. Fail-closed preserved. Everything else — gateway, loop guard, relay chain, service worker, tripwire — stays exactly as-is.