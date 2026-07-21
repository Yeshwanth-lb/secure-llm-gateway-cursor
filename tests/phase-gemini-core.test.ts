// ===== GEMINI EXTENSION — INTERCEPTOR CORE (headless unit tests) ============
// The browser-dependent parts of the extension (DOM, MutationObserver, real
// Gemini composer) can only be validated against a live page — but the control
// logic that the review flagged as the actual risk center (loop guard,
// synthetic-event recognition, fail-closed decision) is pure and IS testable
// here with zero browser.
//
// Design ref: scripts/gemini_imp.md §7 risks 1-3; §6 Stage 3 loop-guard edge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInterceptor, decideSubmission, SYNTHETIC } from "../extension/src/interceptor-core.js";
import { bodyLooksRaw, shouldInspectUrl, installTripwire } from "../extension/src/tripwire.js";

// --- LOOP GUARD: our own re-submit must not be re-intercepted ---------------
test("loop guard: real user submit is intercepted; our synthetic re-submit is not", () => {
  const ix = createInterceptor();

  // A genuine, trusted user submit -> intercept it.
  assert.equal(ix.shouldIntercept({ isTrusted: true }), true);

  // An event we tagged as our own synthetic re-submit -> do NOT intercept.
  const mine = ix.markSynthetic({ isTrusted: false });
  assert.equal(ix.isSynthetic(mine), true);
  assert.equal(mine[SYNTHETIC], true);
  assert.equal(ix.shouldIntercept(mine), false);

  // An untrusted event we did NOT tag -> also not a real user submit -> skip.
  assert.equal(ix.shouldIntercept({ isTrusted: false }), false);
});

test("loop guard: while a re-submit is in flight, no further submit is intercepted", async () => {
  const ix = createInterceptor();
  let interceptedDuringResubmit = null;

  await ix.runResubmit(async () => {
    // Simulate the synchronous dispatch of our redacted submit: the listener
    // fires DURING this window and asks whether to intercept.
    interceptedDuringResubmit = ix.shouldIntercept({ isTrusted: true });
    assert.equal(ix.isResubmitting(), true, "guard held during re-submit");
  });

  assert.equal(interceptedDuringResubmit, false, "must not intercept our own in-flight re-submit");
  assert.equal(ix.isResubmitting(), false, "guard cleared after re-submit completes");
});

test("loop guard: guard is cleared even if the re-submit throws", async () => {
  const ix = createInterceptor();
  await assert.rejects(
    ix.runResubmit(async () => {
      throw new Error("composer rejected synthetic event");
    }),
  );
  assert.equal(ix.isResubmitting(), false, "guard must not stick after an error");
  // And a subsequent genuine submit is interceptable again.
  assert.equal(ix.shouldIntercept({ isTrusted: true }), true);
});

// --- FAIL-CLOSED decision ---------------------------------------------------
test("decideSubmission: gateway unreachable -> block (never send raw)", () => {
  const d = decideSubmission({ ok: false, originalText: "email alice@corp.com" });
  assert.equal(d.action, "block");
  assert.equal(d.reason, "gateway-unreachable");
});

test("decideSubmission: ok -> submit the redacted text, not the raw original", () => {
  const d = decideSubmission({
    ok: true,
    piiDetected: true,
    redacted: "email [REDACTED_PII_EMAIL]",
    originalText: "email alice@corp.com",
  });
  assert.equal(d.action, "submit");
  assert.equal(d.text, "email [REDACTED_PII_EMAIL]");
  assert.ok(!d.text.includes("corp.com"), "raw value must never be the submitted text");
});

test("decideSubmission: ok + clean text -> submit unchanged (redacted echoes original)", () => {
  const d = decideSubmission({
    ok: true,
    piiDetected: false,
    redacted: "just a normal prompt",
    originalText: "just a normal prompt",
  });
  assert.equal(d.action, "submit");
  assert.equal(d.text, "just a normal prompt");
});

// --- TRIPWIRE predicate (secondary net) -------------------------------------
test("tripwire: raw PII in a body is detected; redacted/clean bodies are not", () => {
  // Raw shapes the DOM path should have removed -> tripwire must catch.
  assert.equal(bodyLooksRaw(`{"q":"mail ${"bob" + "@" + "x.com"}"}`), true, "raw email");
  assert.equal(bodyLooksRaw(`ssn ${["078", "05", "1120"].join("-")}`), true, "raw SSN");
  assert.equal(bodyLooksRaw(`card ${["4111", "1111", "1111", "1111"].join("")}`), true, "raw card");

  // Already-redacted / clean bodies -> tripwire stays quiet (no false abort).
  assert.equal(bodyLooksRaw('{"q":"mail [REDACTED_PII_EMAIL]"}'), false, "redacted token is not raw");
  assert.equal(bodyLooksRaw('{"q":"refactor the add() function"}'), false, "clean text");
  assert.equal(bodyLooksRaw(undefined as unknown as string), false, "non-string is safe");
});

// --- PHASE G4 GATE: Luhn + endpoint-scoped tripwire, ON by default ----------
// A fake `win` lets us drive installTripwire() headlessly: it wraps fetch + XHR,
// so we assert the abort/pass-through decisions with no browser and no new dep.
function makeFakeWin() {
  const events: any[] = [];
  const calls: any[] = [];
  class FakeXHR {
    _url = "";
    open(_method: string, url: string) {
      this._url = url;
    }
    send(body?: any) {
      calls.push({ xhr: true, url: this._url, body });
    }
  }
  const win: any = {
    fetch(input: any, init: any) {
      calls.push({ url: typeof input === "string" ? input : input && input.url, body: init && init.body });
      return Promise.resolve("passed-through");
    },
    XMLHttpRequest: FakeXHR,
    dispatchEvent(e: any) {
      events.push(e);
      return true;
    },
  };
  return { win, events, calls };
}

const GEMINI_URL =
  "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=x";
const TELEMETRY_URL = "https://play.google.com/log?format=json&hasfast=true";
const RAW_EMAIL = "hi " + "bob" + "@" + "corp.com";
const LUHN_CARD = ["4111", "1111", "1111", "1111"].join(""); // valid Luhn test card
const NON_LUHN_16 = ["4111", "1111", "1111", "1112"].join(""); // 16 digits, fails Luhn

// happy: a redacted body bound for the Gemini endpoint passes straight through.
test("G4 tripwire happy: redacted body on the Gemini endpoint is NOT aborted", async () => {
  const { win, events, calls } = makeFakeWin();
  installTripwire(win);
  const res = await win.fetch(GEMINI_URL, { body: '{"q":"mail [REDACTED_PII_EMAIL]"}' });
  assert.equal(res, "passed-through", "clean/redacted send must reach the real fetch");
  assert.equal(calls.length, 1, "exactly one forwarded call");
  assert.equal(events.length, 0, "no blocked event for a clean body");
});

// failure: raw PII bound for the Gemini endpoint is aborted (fetch + XHR),
// fail-closed with a blocked event — the leak the DOM path should have caught.
test("G4 tripwire failure: raw PII on the Gemini endpoint is aborted (fetch + XHR)", async () => {
  const { win, events, calls } = makeFakeWin();
  installTripwire(win);

  await assert.rejects(
    win.fetch(GEMINI_URL, { body: JSON.stringify({ q: RAW_EMAIL }) }),
    /tripwire/i,
    "raw email fetch must be rejected",
  );

  const xhr = new win.XMLHttpRequest();
  xhr.open("POST", GEMINI_URL);
  assert.throws(() => xhr.send(`card ${LUHN_CARD}`), /tripwire/i, "raw card XHR must throw");

  assert.equal(calls.length, 0, "no raw body may reach the real transport");
  assert.equal(events.length, 2, "each abort fires a fail-closed blocked event");
  assert.ok(
    events.every((e) => String(e.detail && e.detail.reason).startsWith("tripwire")),
    "blocked events are tagged as tripwire",
  );
});

// edge: the exact regressions that forced the tripwire OFF must NOT recur —
// a non-Luhn digit run is not PII, and a non-Gemini (telemetry) request is never
// inspected even if its body looks raw.
test("G4 tripwire edge: non-Luhn digits + off-endpoint telemetry are NOT aborted", async () => {
  // Non-Luhn 16-digit run is not a card (Luhn gate), so the body is not "raw".
  assert.equal(bodyLooksRaw(`card ${NON_LUHN_16}`), false, "non-Luhn 16-digit is not a card");
  assert.equal(bodyLooksRaw(`card ${LUHN_CARD}`), true, "Luhn-valid card still caught");

  // Endpoint scoping: only Gemini's generate endpoint is inspected.
  assert.equal(shouldInspectUrl(GEMINI_URL), true, "Gemini generate endpoint is inspected");
  assert.equal(shouldInspectUrl(TELEMETRY_URL), false, "telemetry endpoint is not inspected");

  // Workspace side panel (Gmail/Docs/Sheets/Slides/Chat) — verified live: the
  // generate call is lowercase `streamGenerate` on appsgenaiservice. The tripwire
  // must inspect it too (case-sensitive includes, so listed explicitly).
  const WORKSPACE_URL =
    "https://appsgenaiservice-pa.clients6.google.com/v1/streamGenerate?key=AIzaSyExample";
  assert.equal(shouldInspectUrl(WORKSPACE_URL), true, "Workspace streamGenerate endpoint is inspected");

  // A raw-looking body on a telemetry URL must pass through untouched (this is
  // Google's own traffic — aborting it broke the host app, §7.7).
  const { win, events, calls } = makeFakeWin();
  installTripwire(win);
  const res = await win.fetch(TELEMETRY_URL, { body: JSON.stringify({ id: RAW_EMAIL }) });
  assert.equal(res, "passed-through", "off-endpoint traffic is never aborted");
  assert.equal(calls.length, 1, "telemetry call forwarded");
  assert.equal(events.length, 0, "no blocked event for off-endpoint traffic");
});
