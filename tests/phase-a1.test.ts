// ===== PHASE A1 TESTS — redaction engine (rules, resolution, deep-walk) =======
// Exercises redactText / redactJson through their real interfaces. Zero deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactJson } from "../secure-llm-gateway.ts";

// --- HAPPY: object with email/SSN/CC/api-key -> correct tokens + counts -------
test("happy: deep-walk scrubs email/SSN/CC/api-key with per-type tokens + counts", () => {
  const obj = {
    user: { email: "john.doe@example.com", ssn: "123-45-6789" },
    payment: "card 4111 1111 1111 1111 on file",
    note: "leaked key sk-ant-api03-abc123def456ghi789jklmno",
  };
  const { value, matched } = redactJson(obj, "inbound");
  const v = value as typeof obj;

  assert.equal(v.user.email, "[REDACTED_PII_EMAIL]");
  assert.equal(v.user.ssn, "[REDACTED_PII_SSN]");
  assert.match(v.payment, /\[REDACTED_PII_CREDIT_CARD\]/);
  assert.match(v.note, /\[REDACTED_PII_API_KEY\]/);

  assert.equal(matched.EMAIL, 1);
  assert.equal(matched.SSN, 1);
  assert.equal(matched.CREDIT_CARD, 1);
  assert.equal(matched.API_KEY, 1);

  // security invariant: no raw PII survives anywhere in the output
  const dump = JSON.stringify(value);
  assert.doesNotMatch(dump, /john\.doe@example\.com/);
  assert.doesNotMatch(dump, /123-45-6789/);
  assert.doesNotMatch(dump, /4111/);
});

// --- FAILURE: malformed / non-object input degrades to raw-text scrub, no throw
test("failure: malformed input degrades to raw-text scrub without throwing", () => {
  // a broken JSON string handed straight to the text scrubber
  const raw = "broken { json but email leaks john.doe@example.com here";
  let result: ReturnType<typeof redactText>;
  assert.doesNotThrow(() => {
    result = redactText(raw, "inbound");
  });
  assert.match(result!.text, /\[REDACTED_PII_EMAIL\]/);
  assert.equal(result!.matched.EMAIL, 1);

  // redactJson on a bare string (not an object) must also not throw and still scrub
  const j = redactJson("contact john.doe@example.com", "inbound");
  assert.equal(j.value, "contact [REDACTED_PII_EMAIL]");
  assert.equal(j.matched.EMAIL, 1);
});

// --- EDGE: non-Luhn 16-digit number left untouched ----------------------------
test("edge: non-Luhn 16-digit number is NOT redacted; valid Luhn is", () => {
  const bad = redactText("num 4111 1111 1111 1112 end", "inbound"); // last digit off -> invalid
  assert.equal(bad.text, "num 4111 1111 1111 1112 end");
  assert.equal(bad.matched.CREDIT_CARD, undefined);

  const good = redactText("num 4111 1111 1111 1111 end", "inbound"); // valid Luhn
  assert.match(good.text, /\[REDACTED_PII_CREDIT_CARD\]/);
  assert.equal(good.matched.CREDIT_CARD, 1);
});

// --- extra: outbound direction uses the mock token ----------------------------
test("outbound direction emits [REDACTED_MOCK_PII] regardless of type", () => {
  const r = redactText("email john.doe@example.com ssn 123-45-6789", "outbound");
  assert.doesNotMatch(r.text, /REDACTED_PII_/);
  assert.match(r.text, /\[REDACTED_MOCK_PII\]/);
  assert.equal(r.matched.EMAIL, 1);
  assert.equal(r.matched.SSN, 1);
});
