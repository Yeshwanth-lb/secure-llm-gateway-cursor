# PRD — Browser Extension for PII Redaction in Gemini (Web)

**Author:** Yeshwanth (with Claude Code)
**Date:** 2026-07-16 (rev. 2 — dropped restore-for-display, per review + decision)
**Status:** Final — pre-build. Scope deliberately narrow; fragility is a first-class risk. Every build stage below is phase-gated with happy/failure/edge test cases, matching this project's existing TDD convention.
**Reuses:** the existing local redaction gateway — as-is, no new endpoint or map logic required (see rev. 2 notes).

---

## Rev. 2 — what changed and why

The first draft included a **reversible placeholder map** (`[EMAIL_1]` -> real value) so Gemini's reply could be un-redacted back to real values for display. A technical review (grounded in the actual shipped code) found this was the single most under-scoped part of the doc, and pointed out real, non-trivial consequences of it (own sent message shows a placeholder; reopening an old conversation shows placeholders forever with no map to fix it).

**Decision: drop restore-for-display entirely.** Redaction is one-way. The user's own message and every reply permanently show the placeholder -- always, consistently, everywhere. This is a deliberate trade-off (less seamless reading experience) in exchange for a much simpler, much more honest, much more buildable system. It also directly resolves several of the review's flagged issues by design rather than by patching:

- No reversible map -> no new redaction mode -> **the existing engine's one-way token substitution (`[REDACTED_PII_EMAIL]`) is reused exactly as-is.**
- No map -> the existing, already-shipped `/redact` endpoint (Phase L, returns `{redacted, matched, piiDetected}`, no map) is used **unchanged**. No new backend work.
- No restoration anywhere -> the user's own message and old conversations showing placeholders is now the *expected*, uniform behavior, not an inconsistency to patch.

What did **not** go away, and is now correctly the primary focus of this PRD: the actual mechanics of intercepting and re-submitting the message (see Stage 3), and the timing guarantees around it (see section 7).

---

## 0. Read this first -- scope honesty

This document specifies a browser extension that redacts PII in the **standalone Gemini web app (gemini.google.com)** by rewriting the prompt in the input box before it is submitted. Redaction is **one-way and permanent** -- no original values are ever restored, anywhere, at any point.

Three honesty notes that must travel with this PRD, not be buried:

1. **This is best-effort, not airtight.** Unlike the Claude Code gateway (which sits *in* the request path and cannot be bypassed), a browser extension sits *beside* the path -- it edits the input box before send. If it misses a submit path, loses a timing race, or a UI change breaks its selectors, PII can leak silently. A silent-failure security tool is a real liability; this must be communicated to anyone who relies on it.
2. **Native and commercial alternatives already exist.** Google's own Workspace DLP + Chrome Enterprise Premium cover the *file-access* and some browser-PII-masking cases natively. Commercial products (ORION, Strac, etc.) already sell browser-based GenAI prompt DLP. Building in-house is a legitimate choice for cost/control/custom-PII reasons, but it should be a *conscious* build-vs-buy decision.
3. **Scope is Gemini web only for v1.** Workspace side-panels (Gmail/Docs/Sheets) are explicitly out of scope for v1 -- each is a separate, more fragile build. Meet/Chat/Calendar are out entirely.

---

## 1. Goal & non-goals

### Goal
When a user submits a prompt containing PII into gemini.google.com, replace each PII value with a fixed placeholder token (e.g. `[REDACTED_PII_EMAIL]`) **before the prompt leaves the browser**, using the existing local gateway's redaction engine, unchanged. The placeholder is permanent -- it is never restored, in the user's own sent message or in any reply, ever.

### Non-goals (v1)
- Restoring real values for display, anywhere, at any time -- deliberately dropped (see rev. 2 notes).
- Workspace side-panel Gemini (Gmail, Docs, Sheets, Slides, Drive) -- future, per-app, out of scope now.
- Meet / Chat / Vids / Calendar Gemini -- out of scope.
- Attachments, images, pasted rich content -- text prompts only.
- Being unbypassable -- this is best-effort; the airtight guarantee is not achievable in a browser (see section 7).

---

## 2. Why a browser extension (and why not the gateway approach)

The Claude Code / Gemini CLI approach works because those tools make their API call **from the user's machine**, so the local gateway sits in the request path. Gemini web does **not** -- the browser sends the prompt to Google's servers, which call the model. So there's no request path on the machine for the gateway to occupy.

The only component that runs locally and is positioned between the user's typing and the outbound request is a **browser extension**. It cannot cleanly rewrite the outbound request body (Chrome Manifest V3 forbids modifying request bodies), so the viable strategy is **DOM-level**: read and rewrite the text in the input box before submit, then re-trigger the submit. The extension still *uses* the existing gateway exactly as it already exists -- no changes to it.

---

## 3. High-level architecture

```
+---------------------------- USER'S MACHINE ------------------------------+
|                                                                           |
|   +----------------- Chrome (gemini.google.com tab) ------------------+  |
|   |                                                                    |  |
|   |   [ Prompt input box ]                                            |  |
|   |        |                                                          |  |
|   |        | (1) user submits -- content script intercepts FIRST      |  |
|   |        |     (capture-phase preventDefault + stopImmediatePropagation)
|   |        v                                                          |  |
|   |   +-------------------------+                                     |  |
|   |   | Content script (MAIN)   |                                     |  |
|   |   |  - kill original submit  |                                     |  |
|   |   |  - read box text         |                                     |  |
|   |   |  - await redact          |<---- (3) redacted text only         |  |
|   |   |  - write redacted text   |                                     |  |
|   |   |  - PROGRAMMATICALLY      |                                     |  |
|   |   |    re-fire submit        |                                     |  |
|   |   +---------+---------------+                                     |  |
|   |             | (2) POST raw text                                    |  |
|   +-------------+--------------------------------------------------+  |
|                 |                                                       |
|                 v                                                       |
|   +------------------------------+                                     |
|   | Local gateway  127.0.0.1:8000 |  (existing Phase L /redact, AS-IS)  |
|   |  POST /redact                 |                                     |
|   |  - detect PII                 |                                     |
|   |  - one-way token substitution  |                                     |
|   |  - return {redacted, matched}  |                                     |
|   +------------------------------+                                     |
|                                                                           |
+---------------------------------------------------------------------------+
                 | (4) redacted prompt re-submitted, sent by Gemini normally
                 v
        Google's servers --> Gemini model --> response
                                    |
                                    v
        Rendered as-is in the page. NO restoration -- placeholders are
        permanent in both the user's own sent bubble and the reply.
```

Key point: the raw PII travels only **from the browser to the local gateway and back** -- both on the same machine. The text that actually leaves the machine for Google is already, permanently redacted. There is no map, no un-redaction, and nothing to restore, anywhere.

---

## 4. Components

### 4.1 Content script (MAIN world, `document_start`)
Runs inside the Gemini page's own JavaScript context so it can see and manipulate the composer and intercept the submit action before the page's own handler runs.
- **Attach to the composer:** locate the prompt input element (contenteditable/textarea).
- **Listen as high and as early as possible:** register the capture-phase listener on `document` (not the composer element) so it fires before Gemini's own handler, wherever in the tree Gemini attaches its listener. Capture phase runs top-down, so a listener on a descendant element can still lose the race to one Gemini has on `document`/`window`.
- **Intercept submit, correctly (this is the hard part -- see section 7):** on submit, call `preventDefault()` **and** `stopImmediatePropagation()` to fully kill the original event -- you cannot pause and later resume the same event across an async gap.
- **Redact:** read the current text, `await` the gateway's `/redact` call, get back the redacted text (one-way, no map).
- **Re-submit programmatically, without re-triggering yourself (loop guard):** before writing the redacted text back and re-firing submission, set a module-level flag (e.g. `isResubmitting = true`) or tag the synthetic event so your own capture-phase listener recognizes and ignores it. Without this guard, the script-initiated resubmit is itself a submit event, gets caught by the same listener, and either loops or double-redacts. Clear the flag once the resubmit has fired.
- **Use real input events, not just a text assignment:** Gemini's composer is framework-bound (Angular-class change detection is expected). Setting `textContent`/`value` directly will not update the framework's internal model. Dispatch the redacted text via the native property setter followed by a genuine `input` (and `beforeinput` if needed) event, so the framework's own value binding picks up the change before resubmission.
- **Expect the resubmit to be untrusted:** synthetic/programmatic events have `isTrusted: false`. Some frameworks or native form-submission paths ignore untrusted events outright. This is not assumed safe -- it is exactly what Stage 3's network-level check (section 6) exists to catch.
- **No un-redaction step.** The response renders as Gemini sends it; nothing is watched or swapped afterward.

### 4.2 Isolated content script (bridge)
Relays configuration only (redaction on/off, gateway URL) between the MAIN-world script and `chrome.storage`. No token map to relay, since none exists in this design.

### 4.3 Local gateway -- existing `/redact` endpoint, unchanged
Reuses the already-shipped Phase L endpoint exactly as it exists today:
- Request: `{ "text": "<raw prompt>" }`
- Response: `{ "redacted": "<text with fixed tokens>", "matched": {...}, "piiDetected": true }`
- **No changes needed.** No map field, no reversibility, no new mode. This is the direct benefit of dropping restoration.
- Known existing behavior (confirmed against shipped code, not assumed): missing/malformed `text` is treated as empty and returns `200`, not `400`. **Test expectations in section 6 are written to match this actual behavior** -- not changed, to avoid any risk to the existing Cursor Phase L path.

### 4.4 Fail-closed network tripwire (secondary safety net)
A MAIN-world `fetch`/`XHR` wrapper that inspects outgoing Gemini requests and, if a request body still contains a raw PII pattern (i.e. the DOM rewrite/re-submit somehow missed it), **aborts the request** rather than letting it leave. This is a backup, not the primary mechanism -- and it has known blind spots (see section 7).

### 4.5 Enterprise deployment
Force-install via Google Admin console (Devices > Chrome > Apps & extensions), pushed to a pilot org-unit first. Force-installed extensions can't be removed by users and retain access to blocking `webRequest` (useful for the tripwire, which can only abort, not modify -- consistent with what MV3 allows). Redaction rules pushed via managed configuration (`chrome.storage.managed`).

---

## 5. Data flow, step by step

1. User types a prompt containing `alice@corp.com` and submits.
2. Content script's `document`-level capture-phase listener fires **first**, calls `preventDefault()` + `stopImmediatePropagation()` -- the original submit is fully killed, not paused.
3. Content script reads the box text, `await`s a POST to `127.0.0.1:8000/redact`.
4. Gateway (unchanged) returns `{ "redacted": "email [REDACTED_PII_EMAIL]", "matched": {"EMAIL": 1}, "piiDetected": true }`.
5. Content script sets the `isResubmitting` flag, writes the redacted text into the box via the native setter + a real `input` event (so the framework's model updates, not just the DOM).
6. Content script **programmatically re-triggers submission** -- a new, second submit event it initiates itself. Because of the flag from step 5, its own listener recognizes and ignores this event rather than re-intercepting it. Flag is cleared once this fires.
7. Gemini reads the box (now redacted) and sends it to Google's servers as a normal submission.
8. Gemini's reply renders in the page, referencing or discussing `[REDACTED_PII_EMAIL]` as it sees fit. **Nothing is swapped or restored.** The user reads the placeholder, permanently, in both their own sent message and the reply.
9. No map exists, so there is nothing to clear on tab close.

---

## 6. Build stages -- with test cases per stage

Each stage follows the same phase-gate discipline as the rest of the project (Phase J/K/L): a stage isn't done until its **happy / failure / edge** test trio passes.

---

### Stage 0 -- Build-vs-buy checkpoint (do first, no code)

- [ ] Confirmed with the team: build in-house, vs. configure Google's native Workspace DLP, vs. evaluate a commercial vendor (ORION/Strac-class).
- [ ] Decision and reasoning documented durably (this doc or a linked ticket).

---

### Stage 1 -- Confirm the existing `/redact` endpoint meets this design's needs (no new backend code expected)

Since this design needs no map, the existing Phase L endpoint should already be sufficient. This stage is verification, not new construction.

- **Happy:** POST text containing one email -> response `redacted` field has the email replaced with the fixed token; `matched.EMAIL >= 1`.
- **Failure (matches actual shipped behavior -- do not assume a 400 that doesn't exist):** POST with missing/malformed `text` -> confirmed `200` response, text treated as empty, no crash. If stricter validation is later desired, that's a deliberate, separate change to the Cursor-shared endpoint -- not assumed here, and not made without checking impact on the existing Cursor Phase L path.
- **Edge:** text with multiple PII types at once -> all replaced with their respective fixed tokens, `matched` reflects each type and count correctly; text with no PII -> returned unchanged, `piiDetected: false`.

**Stage gate:** confirm via direct testing against the real, already-running endpoint -- this should require zero new backend code. If it doesn't meet the need, stop and reassess before writing extension code against a wrong assumption.

---

### Stage 2 -- Extension skeleton (loads and locates elements, doesn't touch text yet)

- **Happy:** on `gemini.google.com`, the content script loads, correctly locates the composer element, and confirms it via a dev-mode indicator -- no redaction logic wired yet.
- **Failure:** extension present but tab is on an unrelated domain -> content script does **not** activate (manifest scoping confirmed correct).
- **Edge:**
  - Composer not yet rendered at `document_start` (common in single-page apps) -> script waits/retries rather than failing outright.
  - Extension reloaded mid-session -> re-attaches cleanly with exactly one listener registered, not duplicates (duplicates would cause double-redaction/double-submit later).

**Stage gate:** confirmed against a real, current Gemini page -- not a saved local copy.

---

### Stage 3 -- Intercept, redact, and re-submit (the hard core -- own this framing explicitly)

This is the stage the review correctly identified as the actual risk center. The mechanism is **not** "pause and resume" -- it is **kill the original event entirely, then independently initiate a new one** after the async redact call completes.

- **Happy:** submit text containing PII -> the original submit is fully prevented (confirm via a test that the *unredacted* text never reaches a network call) -> gateway call completes -> box is rewritten -> a **new, script-initiated submission** succeeds -> inspect the actual outgoing network request and confirm **zero raw PII** is present.
- **Failure:** gateway unreachable (stop the gateway, or point at a dead port) -> **no re-submission is ever triggered** -- the message is not sent in any form, and the user sees a clear message explaining why (fail-closed).
- **Edge (all required):**
  - Confirm `stopImmediatePropagation()` genuinely prevents Gemini's own handler from also firing on the *original* event (test for exactly one network request total, not two). This requires the listener to be registered on `document` in capture phase, ahead of wherever Gemini attaches its own handler -- a listener on the composer element alone can lose this race if Gemini listens higher in the tree.
  - **Loop guard, tested explicitly:** the script-initiated resubmit (step 6 in section 5) must not be re-caught by the same capture-phase listener. Test for exactly one `/redact` gateway call per user submission -- if the resubmit re-triggers the interceptor, this will show as two (or an infinite loop of) gateway calls instead of one.
  - **Model-binding check:** after the box is rewritten, confirm the framework's own internal state (not just the visible DOM) reflects the redacted text before resubmission -- e.g. by checking what value the resubmit actually sends, not just what's rendered. A `textContent`/`value` assignment that bypasses the framework's change detection can leave stale (pre-redaction) text in the model even though the DOM looks correct.
  - Re-submission via the extension's programmatic trigger is verified to actually work against Gemini's real composer (this is explicitly a feasibility check, not an assumption -- Angular-based / synthetic-event-hostile UIs are known to be uncooperative with programmatic re-dispatch, and a synthetic resubmit event is `isTrusted: false`, which some handlers ignore outright; if it doesn't work cleanly, this is a Stage 3 blocker to resolve before continuing, not a detail to paper over).
  - Submit via clicking the Send button in addition to Enter -> same interception applies to both paths independently.
  - Rapid double-submit -> both are independently and fully intercepted; no race allows a second, unredacted submission through.
  - Text with no PII -> still passes through the intercept -> redact (no-op) -> re-submit cycle, confirming the mechanism doesn't silently bypass itself when there's nothing to catch.

**Stage gate:** the "exactly one network request, containing zero raw PII" check must be verified by actually inspecting real network traffic. Additionally: **explicitly confirm the programmatic re-submission mechanism works reliably against Gemini's real composer before writing any further stages on top of it** -- per the review, this is the single most likely point of total failure for the whole approach, not a minor implementation detail. The loop-guard and model-binding checks above must also pass -- both are concrete, testable failure modes of the "kill and re-fire" mechanism, not just theoretical concerns.

---

### Stage 4 -- Fail-closed network tripwire (secondary safety net)

- **Happy:** a request that already went through Stage 3's redaction cleanly -> tripwire inspects it, finds nothing, allows it through unchanged.
- **Failure:** deliberately simulate a Stage 3 miss (bypass redaction in a test build so raw PII reaches the network layer) -> tripwire detects it and **aborts the request** before it leaves the machine.
- **Edge:** explicitly construct or identify a Service-Worker-dispatched request and **confirm, rather than assume**, that the tripwire cannot see it. Record this verified limitation in section 7, not as an assumption.

**Stage gate:** the blind-spot edge case must be written into the risk log with the verification method used.

---

### Stage 5 -- Health check + enterprise deployment

- **Happy:** current Gemini page's composer selector and submit mechanism both resolve/work correctly -> health check reports healthy.
- **Failure:** deliberately break the composer selector (simulate a Google UI change) -> health check detects it and the extension **fails closed** -- disables sending rather than continuing with broken interception.
- **Edge:**
  - Force-installed to a pilot org unit -> confirm a user genuinely cannot disable/remove it.
  - Managed configuration pushed via `chrome.storage.managed` -> confirmed received and applied on a freshly-provisioned machine.

**Stage gate:** run the failure-simulation test against a real pilot deployment, not just a local dev environment.

---

**Overall rule across all stages:** a stage is not complete until its failure and edge cases pass, not just its happy path -- and Stage 3 in particular should not be considered "mostly working" until the programmatic re-submission is proven against the real, live Gemini composer.

---

## 7. Risks & limitations (do not bury these)

1. **The submit-interception/re-fire mechanic is the primary risk, not the DOM read.** You cannot pause a native DOM event across an async gap -- the design requires fully killing the original event (`preventDefault` + `stopImmediatePropagation`) and independently, programmatically initiating a fresh submission afterward. Re-triggering submit reliably on Gemini's real (likely Angular-based) composer is unproven until Stage 3's gate is met, and is the single most likely point of total failure for this whole approach.
2. **The re-fire can re-trigger your own interceptor (loop/double-redact).** The script-initiated resubmit is, from the page's perspective, just another submit event -- without an explicit guard (a resubmitting flag the listener checks and ignores), your own capture-phase listener catches its own resubmit, redacting again or looping. This must be built and tested as its own mechanism (Stage 3), not assumed away by "it's just a resubmit."
3. **Writing text back may not update the framework's model.** Directly setting `textContent`/`value` on the composer can leave Angular-class change detection unaware of the change, so the resubmit could send stale (pre-redaction) text even though the DOM looks correct. Requires dispatching through the native setter + a real `input` event, and verifying the *actual sent value*, not just the visible box content.
4. **MAIN-world script injection timing has no hard guarantee.** `document_start` MAIN-world injection ordering versus the page's own bootstrap is best-effort in Chrome -- this compounds risks 1-2, since the interception depends on the content script's listener being registered (on `document`, capture phase) before Gemini's own submit handler runs.
5. **Silent failure on UI change.** If Google changes the composer's structure, the extension can stop working -- silently. **Mitigation:** the Stage 5 health check, built to fail closed rather than fail silent.
6. **Submit-path coverage.** Enter, send-button, and voice input are separate paths; missing one is a leak. **Mitigation:** capture-phase interception of all known paths + the fail-closed tripwire as backup.
7. **Service Worker blind spot.** Some Gemini traffic is dispatched from a background Service Worker a page-world fetch wrapper can't see -- the network tripwire has holes here. This is why DOM-level interception, not the tripwire, is the primary mechanism.
8. **Permanent placeholders are a real, accepted UX cost.** The user's own sent message and every reply will permanently show tokens like `[REDACTED_PII_EMAIL]` -- in the current session and in all future re-reads of that conversation. This is a deliberate trade-off for a much simpler and more honest system (see rev. 2 notes), not an oversight -- but it should be communicated clearly to end users, since it's a real, visible change to how they read their own chat history.
9. **Not airtight, by nature.** Everything above means this is best-effort. It meaningfully reduces accidental PII exposure; it does not *guarantee* prevention the way the Claude Code gateway does.
10. **Commercial/native overlap.** Google native DLP + Chrome Enterprise Premium and commercial GenAI-DLP vendors already cover parts of this. Revisit build-vs-buy if maintenance cost climbs.
11. **Word-boundary dependence + paste-flattening (observed live 2026-07-20).** Several rules (PHONE_US/PHONE_IN/SSN/CREDIT_CARD/PAN_IN/AADHAAR/IPV4) are anchored on `\b` to avoid false positives, so a value **glued to adjacent characters with no separator** (e.g. `SSN078051120`, or `...0147India` after a multi-line paste whose newlines Gemini's contenteditable stripped) does **not** match — and is sent RAW, silently. This is the FP-avoidance trade-off inherent to the engine (same for Claude Code), surfaced here by Gemini flattening pasted newlines. Normal prose has separators so it's rare, but real. Mitigation ideas (not yet done): a `beforeinput`/paste hook that normalizes pasted whitespace before redaction, or boundary-relaxed variants of the numeric rules. The full-PII generator (`scripts/gen-pii-sample.mjs`) joins fields with a space-preserving separator specifically so paste-flattening doesn't hide a miss during testing.

---

## 8. Success criteria (v1)

- Every stage in section 6 passes its full happy/failure/edge test trio, in particular Stage 3's gate (programmatic re-submission proven against the real Gemini composer) -- this is the primary and most important gate in the whole plan.
- On gemini.google.com, a prompt containing any supported PII type (email, phone, API key, SSN, PAN, Aadhaar, credit card, IPv4/IPv6, private key, JWT) has that value replaced with its fixed token in the text that actually leaves the browser -- verified by inspecting the outgoing network request directly.
- Exactly one network request occurs per user submission -- never the original unredacted one alongside the redacted one.
- When the composer selector or re-submit mechanism breaks, the extension fails closed (blocks send) rather than silently leaking -- verified against a real pilot deployment.
- The Service-Worker blind spot is verified and logged, not assumed.
- Full round-trip (intercept -> redact -> re-submit) adds no more than a small, acceptable latency.

---

## 9. One-paragraph summary

Gemini web can't be protected by the local-gateway approach that works for Claude Code and Gemini CLI, because Gemini web sends prompts from Google's servers, not the user's machine. The only local interception point is a browser extension, and because Chrome forbids rewriting request bodies, it must work at the DOM level. This revision deliberately drops restoring original values for display: redaction is one-way and permanent, in both the user's own sent message and every reply. That single decision eliminates an entire class of complexity a technical review correctly flagged -- no reversible map, no new redaction mode, and the existing gateway endpoint is reused completely unchanged. What remains, correctly, as the real engineering challenge is Stage 3: fully killing the original submit event and independently, programmatically re-triggering a redacted resubmission -- a mechanism that must be proven against Gemini's real composer before anything is built on top of it. This is genuinely buildable for the standalone Gemini web app, but it remains best-effort, not airtight, and must be built fail-closed and monitored, scoped to Gemini web only for v1, and undertaken only after a conscious build-vs-buy decision.