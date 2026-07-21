// ===== CONTENT SCRIPT (MAIN world) — intercept, redact, re-submit ==========
// Runs in the Gemini page's own JS context at document_start. This is the
// Stage 3 "hard core": kill the user's original submit, redact via the local
// gateway, then INDEPENDENTLY re-fire a redacted submit — without our own
// listener re-catching it (loop guard, §7 risk 2).
//
// Design ref: scripts/gemini_imp.md §4.1, §5, §6 Stage 3, §7 risks 1-4.
// Verified behaviors are enforced by extension/src/interceptor-core.js (pure,
// unit-tested) — this file is the DOM/event glue around that core.

import { createInterceptor, decideSubmission } from "./interceptor-core.js";
import { findComposer, readText, writeText, findSendButton, selectorsHealthy, getModel, readLatestResponse, responseCount } from "./composer.js";
import { installTripwire } from "./tripwire.js";

/**
 * Ask the isolated-world bridge (which relays to the background service worker)
 * to redact `text`. The fetch CANNOT happen here in MAIN world — see
 * background.js for why (gateway CORS is loopback-only). Resolves to the same
 * shape redact-client returns: { ok, redacted, piiDetected }. Fail-closed
 * ({ ok:false }) on timeout so a hung/absent bridge blocks the send.
 */
function requestRedaction(text, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
    const onResp = (e) => {
      if (!e.detail || e.detail.id !== id) return;
      cleanup();
      resolve(e.detail.result || { ok: false });
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false });
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("gemini-redact:redact-response", onResp);
    }
    window.addEventListener("gemini-redact:redact-response", onResp);
    window.dispatchEvent(new CustomEvent("gemini-redact:redact-request", { detail: { id, text } }));
  });
}

const ix = createInterceptor();

// Config is relayed from the isolated-world bridge via a window event (the two
// worlds share the DOM but not variable scope). Defaults are loopback-safe.
// `tripwire` is ON by default (Phase G4): it is now ENDPOINT-SCOPED (only
// Gemini's generate endpoint is inspected) and LUHN-checked, so it no longer
// false-positives on Google's own telemetry. It is the fail-closed safety net
// that catches raw PII if the DOM path breaks after a Gemini UI change — the
// send is aborted rather than leaked. DOM interception remains the primary,
// clean-redaction mechanism. Set config `tripwire:false` (managed/local storage)
// to disable, or `tripwireEndpoints` to tune the inspected-URL list.
let CONFIG = { base: "http://127.0.0.1:8001", enabled: true, tripwire: true, debug: false };
let tripwireInstalled = false;
function applyTripwire() {
  if (CONFIG.tripwire && !tripwireInstalled) {
    installTripwire(window, CONFIG.tripwireEndpoints ? { endpoints: CONFIG.tripwireEndpoints } : {});
    tripwireInstalled = true;
  }
}
window.addEventListener("gemini-redact:config", (e) => {
  if (e && e.detail && typeof e.detail === "object") CONFIG = { ...CONFIG, ...e.detail };
  applyTripwire();
});

/** Show the user why a send was blocked (fail-closed paths). Replace with real UI. */
function notifyBlocked(reason) {
  const msg =
    reason === "gateway-unreachable"
      ? "PII gateway unreachable — message blocked (fail-closed). Start the local gateway and retry."
      : reason === "selectors-broken"
        ? "Redaction extension can't find the composer (Gemini UI may have changed) — sending disabled to avoid leaking PII."
        : "Message blocked by PII redaction policy.";
  console.warn("[gemini-redact]", msg);
  try {
    window.dispatchEvent(new CustomEvent("gemini-redact:blocked", { detail: { reason, msg } }));
  } catch {
    /* non-fatal */
  }
}

/**
 * The submit handler, registered on `document` in CAPTURE phase so it runs
 * before Gemini's own handler wherever that is attached (§7 risk 4). It only
 * fires the redact flow for genuine user submits (loop guard via the core).
 */
async function onSubmitEvent(event) {
  if (!CONFIG.enabled) return; // extension toggled off via managed config
  if (!ix.shouldIntercept(event)) {
    if (CONFIG.debug) console.info("[gemini-redact] skip: shouldIntercept=false", event.type, "trusted=", event.isTrusted);
    return; // our own re-submit / synthetic / untrusted -> let through
  }

  const composer = findComposer();
  if (CONFIG.debug) console.info("[gemini-redact] submit seen:", event.type, "composerFound=", !!composer);
  if (!composer) {
    // Can't read what's being sent -> fail closed rather than let it pass.
    event.preventDefault();
    event.stopImmediatePropagation();
    notifyBlocked("selectors-broken");
    return;
  }

  const text = readText(composer);
  if (CONFIG.debug) console.info("[gemini-redact] readText len=", text.length, "preview=", JSON.stringify(text.slice(0, 40)));
  if (text.trim() === "") {
    if (CONFIG.debug) console.info("[gemini-redact] skip: empty text — send proceeds unredacted");
    return; // empty submit can't leak — let it proceed normally
  }
  if (CONFIG.debug) console.info("[gemini-redact] KILLING original submit + redacting");

  // KILL the original event fully — we cannot pause and resume it across the
  // async gateway call (§7 risk 1).
  event.preventDefault();
  event.stopImmediatePropagation();

  const result = await requestRedaction(text);
  const decision = decideSubmission({ ...result, originalText: text });
  if (CONFIG.debug) {
    console.info(
      "[gemini-redact] intercept:",
      result.ok ? "gateway ok" : "gateway FAIL",
      "piiDetected=" + !!result.piiDetected,
      "action=" + decision.action,
    );
  }

  if (decision.action === "block") {
    notifyBlocked(decision.reason);
    return;
  }

  // Write the redacted text so the framework MODEL updates (not just the DOM),
  // then re-fire a fresh submit with the loop guard held so we don't re-catch it.
  writeText(composer, decision.text);
  if (CONFIG.debug) {
    console.info("[gemini-redact] composer after write:", JSON.stringify(readText(composer).slice(0, 60)));
  }

  // CRITICAL: Gemini's composer (Quill) reads from its OWN internal model
  // (Delta), which it syncs from DOM mutations ASYNCHRONOUSLY. If we re-fire the
  // submit synchronously, Gemini grabs the STALE (raw) model and sends the
  // un-redacted text even though the DOM already shows the token (observed live,
  // §7 risk 3). Yield across a macrotask so the editor's MutationObserver /
  // input pipeline absorbs our change into its model before we submit.
  await new Promise((r) => setTimeout(r, 120));

  await ix.runResubmit(async () => {
    fireSubmit(composer);
  });

  // Log the full turn once the response settles, so the Traffic Inspector shows
  // it like a Claude turn (§clean view). Pass the ORIGINAL (raw) prompt: the
  // gateway redacts it server-side before storing (same loopback path /redact
  // already uses), which makes the inspector's PII flag + rule counts ACCURATE
  // while still persisting only redacted text.
  captureAndLogTurn(text);
}

/**
 * After the prompt is sent, watch the page until Gemini's reply stops changing,
 * then log the turn (raw prompt + captured response) via the bridge →
 * background → /log-turn. The gateway redacts BOTH server-side and stores only
 * redacted text — sending the raw prompt here just lets the inspector show
 * accurate PII flags/counts. Best-effort: a hard timeout guarantees the turn is
 * logged (prompt-only) even if the response can't be captured.
 */
function captureAndLogTurn(rawPrompt) {
  const model = getModel();
  // Snapshot how many assistant-response nodes exist BEFORE our reply arrives.
  // We only capture once a NEW node appears past this baseline — otherwise we'd
  // grab the PREVIOUS turn's reply and mispair prompt↔response in the log.
  const baseline = responseCount();
  let settleTimer = null;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try {
      obs.disconnect();
    } catch {
      /* ignore */
    }
    clearTimeout(hardTimeout);
    // If no new response node ever appeared (e.g. hard timeout, or capture
    // failed), log an EMPTY response rather than a stale earlier reply — a
    // wrong pairing in an audit log is worse than a missing one.
    const response = responseCount() > baseline ? readLatestResponse() : "";
    window.dispatchEvent(
      new CustomEvent("gemini-redact:log-turn", { detail: { prompt: rawPrompt, response, model } }),
    );
  };
  // Start the "settled" countdown only once a NEW reply node has appeared; reset
  // it on every subsequent mutation (streaming). Quiet for 2.5s after the new
  // node exists ⇒ reply finished.
  const obs = new MutationObserver(() => {
    if (responseCount() <= baseline) return; // reply not rendered yet
    clearTimeout(settleTimer);
    settleTimer = setTimeout(finish, 2500);
  });
  try {
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch {
    /* if observation fails, the hard timeout still logs the turn */
  }
  // Hard cap so a turn always logs even if streaming never visibly "settles".
  const hardTimeout = setTimeout(finish, 30000);
}

/**
 * Programmatically re-trigger submission. This is a NEW, script-initiated
 * submit (not a resumption). We tag every synthetic event so the core ignores
 * it, and the resubmitting flag covers anything we can't tag. NOTE (§7 risk 1):
 * synthetic events are isTrusted:false and some framework handlers ignore them
 * — Stage 3's live network check is what proves this actually works.
 */
function fireSubmit(composer) {
  // Pick the send/submit control. CRITICAL (Workspace live finding 2026-07-21):
  // Gmail/Docs/Sheets/Slides/Chat render TWO buttons with aria-label="Submit" —
  // a DISABLED decoy and the real, ENABLED one. Selecting the first match lands
  // the click on the dead button and nothing sends. So we must pick a candidate
  // that is BOTH enabled (`!disabled`) AND visible (`offsetParent !== null`).
  // Scope to the composer's container first (avoids unrelated page buttons like
  // "Send feedback"); then the whole document; then the gemini.google.com send
  // button. gemini web still resolves via the same enabled+visible rule.
  const pickLive = (scope) => {
    if (!scope || !scope.querySelectorAll) return null;
    const cands = [
      ...scope.querySelectorAll(
        'button.send-button, button[aria-label="Submit" i], button[aria-label*="Send message" i], button[aria-label*="Send" i]',
      ),
    ];
    return cands.find((b) => !b.disabled && b.offsetParent !== null) || null;
  };
  let btn = null;
  let box = composer;
  for (let i = 0; i < 8 && box && !btn; i++) {
    btn = pickLive(box);
    box = box.parentElement;
  }
  if (!btn) btn = pickLive(document);
  if (!btn) btn = findSendButton();

  if (btn && !btn.disabled) {
    // Material/Gm3 buttons ignore a bare synthetic click — they listen on the
    // full pointer sequence. Dispatch the whole chain (each tagged synthetic so
    // the loop guard ignores our own re-fire). The trailing `click` also covers
    // the simpler gemini.google.com button, so this is a SUPERSET of the old
    // single-click path — gemini web behavior is preserved.
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor =
        type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      btn.dispatchEvent(ix.markSynthetic(new Ctor(type, { bubbles: true, cancelable: true, view: window })));
    }
    return;
  }
  // Fallback: full synthetic Enter (keydown+keypress+keyup) on the composer.
  for (const type of ["keydown", "keypress", "keyup"]) {
    composer.dispatchEvent(
      ix.markSynthetic(
        new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }),
      ),
    );
  }
}

// Register as early and as high as possible: document, capture phase, for both
// the Enter key and click paths. Capture ensures we run before Gemini's own
// handlers (§7 risk 4).
document.addEventListener("keydown", (e) => {
  // Enter (without Shift) is Gemini's send gesture.
  if (e.key === "Enter" && !e.shiftKey) onSubmitEvent(e);
}, true);
document.addEventListener("click", (e) => {
  const el = e.target;
  if (el && el.closest && el.closest('button[aria-label*="Send" i], button[aria-label*="Submit" i], button[data-testid*="send" i]')) {
    onSubmitEvent(e);
  }
}, true);

// Periodic health check (Stage 5): if selectors break, announce so the isolated
// world / UI can fail closed. Runs light; real deployment wires this to a badge.
setInterval(() => {
  const h = selectorsHealthy();
  if (!h.healthy) notifyBlocked("selectors-broken");
}, 15000);

console.info("[gemini-redact] content script active (MAIN world)");
