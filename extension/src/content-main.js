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
import { findComposer, readText, writeText, findSendButton, selectorsHealthy, getModel, readLatestResponse, responseCount, setLearnedComposer, isGenerating, currentAdapter, setSite, liveSendSelector } from "./composer.js";
import { createResponseCapture } from "./response-capture.js";
import { installTripwire } from "./tripwire.js";
import { installUploadGuard } from "./upload-guard.js";

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
// `settleMs`/`turnTimeoutMs` govern per-turn response capture: how long the
// reply must stop changing before we call it finished, and the hard cap after
// which the turn is logged regardless (prompt-only if no reply was captured).
let CONFIG = {
  base: "http://127.0.0.1:8001",
  enabled: true,
  tripwire: true,
  debug: false,
  settleMs: 2500,
  // Backstop only: we now wait for generation to actually FINISH (isGenerating +
  // placeholder gating) rather than a fixed quiet window, so this just caps a
  // reply that never settles. Generous enough for deep-research/"Collecting info…"
  // turns that legitimately run a while before the answer appears.
  turnTimeoutMs: 120000,
};
// With `all_frames: true` the content script also loads inside the Google
// Workspace Gemini panel, which Gmail/Drive render in a CROSS-ORIGIN
// `chat.google.com` iframe (the "gtn-brain" frame) — the only way to reach the
// reply/composer that live there. But it ALSO loads in unrelated Google
// subframes (ogs widgets, the dynamic-email relay, about:blank). We must arm the
// fail-closed submit interceptor + tripwire ONLY where a Gemini surface actually
// is, or a stray Enter/click in one of those frames would be blocked. Arm in:
//   - the TOP frame — gemini.google.com, or a Workspace app whose panel renders
//     in the top document (Docs/Sheets/Slides via appsElements); or
//   - a chat.google.com subframe — the Gemini panel used by Gmail/Drive.
// Every other subframe stays completely inert (no listeners, no tripwire).
//
// chatgpt.com, grok.com and chat.deepseek.com need nothing extra here: each is a
// single top-level SPA (no cross-origin composer iframe), so the top-frame rule
// already arms them, and any third-party subframe on those pages stays inert.
function isArmableFrame() {
  if (window.top === window) return true; // top frame — unchanged behavior
  return location.hostname === "chat.google.com";
}
const ARMED = isArmableFrame();
// Whether a Gemini composer has EVER been found in this frame. Gates fail-closed:
// a frame that never had a composer is not a Gemini surface, so it must not block
// the user's ordinary submits (fixes the Gmail top-frame "can't find composer"
// flood, where the real composer is in the panel iframe).
let sawComposer = false;

let tripwireInstalled = false;
function applyTripwire() {
  if (ARMED && CONFIG.tripwire && !tripwireInstalled) {
    // Inspect only THIS site's generate endpoint (site-adapter.js), so a ChatGPT
    // URL fragment is never tested against a Gemini page or vice-versa. A storage
    // override still wins, as before.
    const endpoints = CONFIG.tripwireEndpoints || currentAdapter().tripwireEndpoints;
    installTripwire(window, { endpoints, uploadEndpoints: currentAdapter().uploadEndpoints || [] });
    tripwireInstalled = true;
  }
}

// FILE UPLOADS bypass the composer entirely, and the bytes leave at ATTACH time —
// ~19s before the message is sent on ChatGPT (probed live 2026-07-30). So the
// guard hooks change/drop/paste rather than submit. Only enabled on surfaces whose
// upload flow has actually been probed (`adapter.uploadGuard`).
let uploadGuardInstalled = false;
function applyUploadGuard() {
  if (!ARMED || uploadGuardInstalled || CONFIG.uploadGuard === false) return;
  uploadGuardInstalled = installUploadGuard(window, {
    adapter: currentAdapter(),
    redact: requestRedaction,
    notify: notifyBlocked,
    // "block" (default) refuses files it cannot read; "warn" uploads them and
    // files an `unchecked` audit row instead, for people who must attach real
    // work files. Set via managed/local extension storage.
    policy: CONFIG.uploadPolicy,
    audit: (turn) => {
      const adapter = currentAdapter();
      window.dispatchEvent(
        new CustomEvent("gemini-redact:log-turn", {
          detail: { ...turn, provider: adapter.provider, source: adapter.source },
        }),
      );
    },
    debug: CONFIG.debug,
  });
}
window.addEventListener("gemini-redact:config", (e) => {
  if (e && e.detail && typeof e.detail === "object") CONFIG = { ...CONFIG, ...e.detail };
  // `site` forces a site adapter. Production never sets it (the hostname decides);
  // the e2e harnesses do, because their fake pages are served from 127.0.0.1.
  if (CONFIG.site) setSite(CONFIG.site);
  applyTripwire();
  applyUploadGuard();
});

// LAYER 1.5 — the isolated bridge restores the persisted composer fingerprint
// (learned from a prior focused submit) so findComposer can recall the composer
// after a Gemini/Workspace redesign, before the user re-focuses it.
window.addEventListener("gemini-redact:learned-composer", (e) => {
  setLearnedComposer((e && e.detail && e.detail.fingerprint) || null);
});

/** Show the user why a send was blocked (fail-closed paths). Replace with real UI. */
function notifyBlocked(reason, detail) {
  const msg =
    reason === "gateway-unreachable"
      ? "PII gateway unreachable — message blocked (fail-closed). Start the local gateway and retry."
      : reason === "selectors-broken"
        ? "Redaction extension can't find the composer (Gemini UI may have changed) — sending disabled to avoid leaking PII."
        : reason === "upload-blocked"
          ? // Uploads leave at ATTACH time, so this is a refusal to attach at all.
            // Formats we cannot read as text (PDF/DOCX/XLSX/images) can never be
            // scrubbed without adding dependencies, so they are refused rather
            // than uploaded unscanned.
            "File attachment blocked: it can't be scanned for PII (only text-like files can be redacted). Paste the relevant text instead."
          : reason === "admin-blocked"
            ? // An administrator disabled this surface in the gateway AI Controls,
              // so sending is turned off here entirely (not a PII match).
              "This AI surface has been disabled by your administrator. Sending is blocked."
            : "Message blocked by PII redaction policy.";
  console.warn("[gemini-redact]", msg, detail || "");
  try {
    window.dispatchEvent(new CustomEvent("gemini-redact:blocked", { detail: { reason, msg, info: detail || "" } }));
  } catch {
    /* non-fatal */
  }
}

// ADMIN ENFORCEMENT (Phase U). The gateway AI-Controls setting for THIS surface,
// polled from /internal/config/:surface via the SW bridge. `blocked` stops every
// send on the site (admin kill switch / mode "block"); `off` disables redaction
// (raw sends proceed); default is redact (the normal flow). Starts as redact so a
// pre-config send is never accidentally blocked; a failed poll keeps the last
// known policy (never silently drops protection).
let surfacePolicy = { blocked: false, off: false, mode: "redact", enabled: true };
function applySurfacePolicy(cfg) {
  if (!cfg || typeof cfg !== "object") return; // poll failed -> keep current
  const enabled = cfg.enabled !== false;
  const mode = typeof cfg.mode === "string" ? cfg.mode : "redact";
  surfacePolicy = { enabled, mode, blocked: !enabled || mode === "block", off: enabled && mode === "off" };
  if (CONFIG.debug) console.info("[gemini-redact] surface policy:", JSON.stringify(surfacePolicy));
}
window.addEventListener("gemini-redact:policy-response", (e) => {
  if (e && e.detail) applySurfacePolicy(e.detail.result);
});
/** Ask the bridge for this surface's admin policy. */
function requestSurfacePolicy() {
  try {
    const surface = currentAdapter().id;
    window.dispatchEvent(new CustomEvent("gemini-redact:policy-request", { detail: { surface } }));
  } catch {
    /* adapter not ready yet — the interval will retry */
  }
}
if (ARMED) {
  requestSurfacePolicy();
  setInterval(requestSurfacePolicy, 15000); // near-real-time; admin changes land within ~15s
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
  if (composer) sawComposer = true;
  if (CONFIG.debug) console.info("[gemini-redact] submit seen:", event.type, "composerFound=", !!composer);
  if (!composer) {
    // No composer in THIS frame. Two very different cases:
    //   - this frame IS a Gemini surface whose composer we've seen before (its
    //     selectors just broke) -> FAIL CLOSED, block the send; or
    //   - this frame simply hosts no Gemini composer (e.g. the Gmail top frame,
    //     whose composer lives in the chat.google.com panel iframe, or any other
    //     armed-but-composerless frame) -> stay INERT so we don't block the user's
    //     ordinary Enter/click there.
    // `sawComposer` distinguishes them: we only fail closed once this frame has
    // actually had a Gemini composer at least once.
    if (!sawComposer) return;
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

  // ADMIN POLICY (Phase U) — checked on a REAL send (composer found, non-empty),
  // before redaction:
  //   - blocked: an admin disabled this surface (kill switch / mode "block") ->
  //     stop the send entirely. This is the "restrict the user" control.
  //   - off: redaction disabled for this surface -> return WITHOUT killing the
  //     event so the page's own submit proceeds with the raw text.
  if (surfacePolicy.blocked) {
    event.preventDefault();
    event.stopImmediatePropagation();
    notifyBlocked("admin-blocked");
    return;
  }
  if (surfacePolicy.off) {
    if (CONFIG.debug) console.info("[gemini-redact] surface mode=off — send proceeds unredacted");
    return; // let the native submit go (raw) — admin turned redaction off here
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
  captureAndLogTurn(text, decision.text, composer);
}

/**
 * After the prompt is sent, watch the page until Gemini's reply stops changing,
 * then log the turn (raw prompt + captured response) via the bridge →
 * background → /log-turn. The gateway redacts BOTH server-side and stores only
 * redacted text — sending the raw prompt here just lets the inspector show
 * accurate PII flags/counts. Best-effort: a hard timeout guarantees the turn is
 * logged (prompt-only) even if the response can't be captured.
 *
 * Two capture paths, in this order:
 *   1. The semantic RESPONSE_SELECTORS (gemini.google.com + the appsElements
 *      panel in Docs/Sheets/Slides). Unchanged, so those surfaces don't move.
 *   2. Shape-based capture anchored on the text we just sent
 *      (response-capture.js), for the obfuscated panels — Gmail, Drive, Chat —
 *      whose class names rotate every Google deploy. Those used to log "(none)".
 * Both can still yield "", which stays the honest answer: a wrong prompt↔reply
 * pairing in an audit log is worse than a blank one.
 */
function captureAndLogTurn(rawPrompt, sentText, composer) {
  const adapter = currentAdapter();
  const model = getModel();
  // Snapshot the assistant-response state BEFORE our reply arrives, so we only
  // capture THIS turn's reply and never mispair a previous turn's answer.
  //   - count: gemini.google.com appends a NEW node per turn (count grows).
  //   - text: the Workspace side panel (Docs/Gmail/Chat/…) streams the reply
  //     INTO an EXISTING bubble, so the node count does NOT grow — a pure
  //     count test misses it and those apps logged an empty response even
  //     though the selector resolved. So also treat the latest bubble's text
  //     CHANGING from this snapshot as this turn's reply.
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const sent = norm(sentText || rawPrompt);

  // A reply is still a LOADING PLACEHOLDER (not the answer) when it's empty, a
  // bare status label, or a short "Collecting info…/Thinking…" line Gemini shows
  // BEFORE the answer. Settling on one of these logged the placeholder and missed
  // the real reply that arrived later (deep-research / slow turns).
  const LOADING_RE =
    /\b(collecting info|thinking|working on it|searching|analy[sz]ing|generating|reasoning|hold on|just a (?:sec|moment)|let me (?:think|check))\b/i;
  // The status LABELS a site renders inside the reply node are per-site
  // (site-adapter.js); ChatGPT has none, so those steps are skipped there.
  const labelOnly = adapter.responseLabelOnly;
  const labelPrefix = adapter.responseLabelPrefix;
  const isPlaceholder = (t) => {
    const n = norm(t);
    if (!n) return true;
    if (labelOnly && labelOnly.test(n)) return true;
    const body = labelPrefix ? n.replace(labelPrefix, "") : n;
    return LOADING_RE.test(body) && body.length < 60;
  };
  // Drop the leading status label from the text we actually store.
  const clean = (t) => (labelPrefix ? norm(t).replace(labelPrefix, "") : norm(t));

  const shape = createResponseCapture(sentText || rawPrompt, document, composer);

  // Read THIS turn's reply: the LAST NON-EMPTY selector node whose text isn't our
  // own submitted prompt (never log the user's bubble). "" if none.
  const readReply = () => {
    const t = readLatestResponse();
    if (!t) return "";
    return norm(t) === sent ? "" : t;
  };
  // Best available reply text (selectors first, else shape), placeholders excluded.
  const replyText = () => {
    const s = readReply();
    if (s && !isPlaceholder(s)) return s;
    if (shape.hasCandidate()) {
      const r = shape.read();
      if (r && !isPlaceholder(r)) return r;
    }
    return "";
  };
  // Snapshot the PREVIOUS reply so we can tell this turn's reply apart.
  const baselineReply = replyText();
  let settleTimer = null;
  let lastReply = "";
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
    const response = clean(replyText());
    if (CONFIG.debug) {
      console.info(
        "[gemini-redact] turn captured, generating=" + isGenerating(),
        "responseLen=" + response.length,
      );
    }
    // provider/source identify the SURFACE in the gateway's traffic log:
    // gemini → provider "gemini", ChatGPT → provider "openai" (its API family,
    // already a valid Provider — the frozen enum needs no change).
    window.dispatchEvent(
      new CustomEvent("gemini-redact:log-turn", {
        detail: { prompt: rawPrompt, response, model, provider: adapter.provider, source: adapter.source },
      }),
    );
  };
  // Arm the "settled" countdown once a real (non-placeholder) reply is present,
  // and RESTART it only when the reply TEXT changes (streaming) — NOT on every
  // stray mutation. Restarting on any mutation meant an idle page whose "Stop"
  // control lingered (or that kept mutating) never settled and only logged at the
  // hard-timeout ~a minute later. The quiet window is short once generation has
  // clearly finished, and a few seconds longer as a fallback while a Stop control
  // is still shown, so even a surface where that signal lingers logs in seconds.
  const obs = new MutationObserver(() => {
    shape.sample();
    const t = replyText();
    if (t === "" || t === baselineReply) return; // no real reply yet
    if (t !== lastReply) {
      lastReply = t;
      clearTimeout(settleTimer);
      const quiet = isGenerating() ? CONFIG.settleMs * 3 : CONFIG.settleMs;
      settleTimer = setTimeout(finish, quiet);
    }
  });
  try {
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch {
    /* if observation fails, the hard timeout still logs the turn */
  }
  // Hard cap so a turn always logs even if streaming never visibly "settles".
  const hardTimeout = setTimeout(finish, CONFIG.turnTimeoutMs);
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
    let cands;
    try {
      cands = [...scope.querySelectorAll(liveSendSelector())];
    } catch {
      return null;
    }
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

// Only arm the interceptor in a Gemini-surface frame (see isArmableFrame). In
// any other subframe pulled in by all_frames we install NOTHING, so a stray
// Enter/click there is never intercepted or blocked.
if (ARMED) {
  // Register as early and as high as possible: document, capture phase, for both
  // the Enter key and click paths. Capture ensures we run before Gemini's own
  // handlers (§7 risk 4).
  document.addEventListener("keydown", (e) => {
    // Enter (without Shift) is Gemini's send gesture.
    if (e.key === "Enter" && !e.shiftKey) onSubmitEvent(e);
  }, true);
  // Clicking the send control is the other submit gesture. The generic labels
  // below cover Gemini and ChatGPT, but a surface can label its button with
  // nothing at all — Grok's is an unlabeled `button[type="submit"]`, which none
  // of them match, so a mouse click there would skip interception entirely and
  // send the raw prompt (the tripwire would abort it: fail-closed, no leak, but
  // the message silently fails). So UNION the generic labels with the current
  // site's live-send selector. Union, not replacement: the generic list is what
  // Gemini and ChatGPT have always matched on, and narrowing it is a leak risk.
  // `liveSendSelector` (not `sendButtonSelectors`) is used deliberately — the
  // latter ends in broad catch-alls like `button:has(mat-icon)`, and treating
  // every icon button on a Gemini page as a send control would kill unrelated
  // clicks whenever the composer has text.
  const clickSendSelector = () =>
    'button[aria-label*="Send" i], button[aria-label*="Submit" i], button[data-testid*="send" i], ' + liveSendSelector();
  document.addEventListener("click", (e) => {
    const el = e.target;
    let hit = false;
    try {
      hit = !!(el && el.closest && el.closest(clickSendSelector()));
    } catch {
      hit = false; // a selector this engine can't parse must not break the listener
    }
    if (hit) onSubmitEvent(e);
  }, true);

  // Periodic health check (Stage 5): if selectors break, announce so the isolated
  // world / UI can fail closed. Runs light; real deployment wires this to a badge.
  setInterval(() => {
    const h = selectorsHealthy();
    if (h.composer) sawComposer = true;
    // Only warn once this frame is known to be a Gemini surface (a composer was
    // seen before) — otherwise a composerless armed frame would spam "broken".
    if (!h.healthy && sawComposer) notifyBlocked("selectors-broken");
  }, 15000);

  // Install at boot too, not only when config arrives: the guard needs no config
  // (its surface comes from the hostname), and a missing/late bridge must not
  // leave file attachments unguarded. Both paths are idempotent.
  applyUploadGuard();

  console.info("[gemini-redact] content script active (MAIN world) frame=", location.host);
}
