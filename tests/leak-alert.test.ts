// Leak-alert logic (Cursor unblockable-leak desktop alert, 2026-07-29).
// The two Cursor paths a hook cannot block — a queued send and an auto-attached
// open/selected file — are audited, not prevented. `isConfirmedLeak` is the pure
// decision that turns an audited turn into an operator alert; `notifyDesktop` is the
// best-effort side-effect. Only the pure decision + the suppression guard are tested
// here (a real notification is a GUI side-effect we never fire in the suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isConfirmedLeak, notifyDesktop } from "../scripts/lib.mjs";

test("happy: a flagged turn with gateway-detected PII is a confirmed leak", () => {
  // queued send (unchecked) OR auto-attached file (scanExtra), both with PII found.
  assert.equal(isConfirmedLeak({ unchecked: true }, { piiDetected: true }), true);
  assert.equal(isConfirmedLeak({ scanExtra: "x" }, { piiDetected: true }), true);
});

test("failure: flagged-but-no-PII and PII-but-not-flagged are NOT leaks", () => {
  // Flagged path, but the gateway found nothing → not a leak (nothing sensitive left).
  assert.equal(isConfirmedLeak({ unchecked: true }, { piiDetected: false }), false);
  // PII in an ordinary (gate-seen) turn → covered by the block hook, not a bypass.
  assert.equal(isConfirmedLeak({ unchecked: false }, { piiDetected: true }), false);
  // A failed/absent /log-turn response is never treated as a confirmed leak.
  assert.equal(isConfirmedLeak({ unchecked: true }, null), false);
  assert.equal(isConfirmedLeak({ unchecked: true }, undefined), false);
});

test("edge: notifyDesktop is suppressed by the env guard and never throws", () => {
  const prev = process.env.GATEWAY_NO_DESKTOP_NOTIFY;
  process.env.GATEWAY_NO_DESKTOP_NOTIFY = "1";
  try {
    // Suppressed → returns false, spawns nothing (so the suite pops no GUI dialog).
    assert.equal(notifyDesktop("t", "b"), false);
    // Hostile / empty input must not throw even while suppressed.
    assert.doesNotThrow(() => notifyDesktop("", ""));
    assert.doesNotThrow(() => notifyDesktop('a "quoted" \\ title', undefined as unknown as string));
  } finally {
    if (prev === undefined) delete process.env.GATEWAY_NO_DESKTOP_NOTIFY;
    else process.env.GATEWAY_NO_DESKTOP_NOTIFY = prev;
  }
});
