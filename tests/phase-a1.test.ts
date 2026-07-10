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

// --- EDGE: loopback IPv4 is not redacted (gateway hook messages cite 127.0.0.1) -
test("edge: loopback IPv4 is left untouched; public IPv4 is redacted", () => {
  const loopback = redactText("gateway at 127.0.0.1:8000 ok", "inbound");
  assert.match(loopback.text, /127\.0\.0\.1/);
  assert.equal(loopback.matched.IPV4, undefined);

  const pub = redactText("server 8.8.8.8 seen", "inbound");
  assert.match(pub.text, /\[REDACTED_PII_IPV4\]/);
  assert.equal(pub.matched.IPV4, 1);
});

// --- extra: outbound direction uses the mock token ----------------------------
test("outbound direction emits [REDACTED_MOCK_PII] regardless of type", () => {
  const r = redactText("email john.doe@example.com ssn 123-45-6789", "outbound");
  assert.doesNotMatch(r.text, /REDACTED_PII_/);
  assert.match(r.text, /\[REDACTED_MOCK_PII\]/);
  assert.equal(r.matched.EMAIL, 1);
  assert.equal(r.matched.SSN, 1);
});

// --- HAPPY: high-signal secrets Claude sees in coding sessions ---------------
test("happy: JWT, PEM key, conn-string, expanded API keys, phones, PAN/Aadhaar", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFBPKJXg";
  const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF6PZX6W
-----END RSA PRIVATE KEY-----`;
  const text = [
    `auth ${jwt}`,
    pem,
    "db postgres://alice:s3cret@db.internal:5432/app",
    "stripe sk_live_51ABCDEFghijklmnopqrstuv",
    "gh github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP",
    "npm npm_abcdefghijklmnopqrstuvwx",
    "hf hf_abcdefghijklmnopqrstuvwx",
    "hook https://hooks.slack.com/services/T01234567/B01234567/abcdefghijklmnopqrstuvwx",
    "call +1 (415) 555-2671 or +91 98765 43210",
    "pan ABCDE1234F aadhaar 4991 1888 0007",
  ].join("\n");

  const { text: out, matched } = redactText(text, "inbound");

  assert.match(out, /\[REDACTED_PII_JWT\]/);
  assert.match(out, /\[REDACTED_PII_PRIVATE_KEY\]/);
  assert.match(out, /\[REDACTED_PII_CONN_STRING\]/);
  assert.match(out, /\[REDACTED_PII_API_KEY\]/);
  assert.match(out, /\[REDACTED_PII_PHONE_US\]/);
  assert.match(out, /\[REDACTED_PII_PHONE_IN\]/);
  assert.match(out, /\[REDACTED_PII_PAN_IN\]/);
  assert.match(out, /\[REDACTED_PII_AADHAAR\]/);

  assert.ok((matched.API_KEY ?? 0) >= 4, "expanded API key families");
  assert.equal(matched.JWT, 1);
  assert.equal(matched.PRIVATE_KEY, 1);
  assert.equal(matched.CONN_STRING, 1);
  assert.equal(matched.PHONE_US, 1);
  assert.equal(matched.PHONE_IN, 1);
  assert.equal(matched.PAN_IN, 1);
  assert.equal(matched.AADHAAR, 1);

  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
  assert.doesNotMatch(out, /BEGIN RSA PRIVATE KEY/);
  assert.doesNotMatch(out, /alice:s3cret@/);
  assert.doesNotMatch(out, /sk_live_51ABCDEF/);
  assert.doesNotMatch(out, /415\) 555-2671/);
  assert.doesNotMatch(out, /98765 43210/);
  assert.doesNotMatch(out, /ABCDE1234F/);
  assert.doesNotMatch(out, /4991 1888 0007/);
});

// --- JWT: short payload (e30), padding, multi-token lists --------------------
test("happy: JWT redacts short payloads, padded signatures, and multi-line lists", () => {
  const jwts = [
    "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzQ4MiIsInJvbGUiOiJhZG1pbiIsImV4cCI6MTc1MzAwMDAwMCwiaWF0IjoxNzUwMDAwMDAwfQ.Kj8mNpQrStUvWxYzAbCdEfGhIjKlMn0pQrStUvWxYzAbCdEfGhIjKlMnOpQ",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFBPKJXg==",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ];
  const text = "tokens:\n\n" + jwts.join("\n\n");
  const { text: out, matched } = redactText(text, "inbound");
  assert.equal(matched.JWT, 3);
  assert.doesNotMatch(out, /eyJhbGci/);
  assert.doesNotMatch(out, /\.e30\./);
  assert.doesNotMatch(out, /==/);
});

// --- FAILURE: random dotted base64 triplets are not JWTs -----------------------
test("failure: random dotted strings without eyJ header are not JWT-redacted", () => {
  const text = "not-a-jwt AbCdEfGhIjKl.AbCdEfGhIjKl.AbCdEfGhIjKl";
  const { text: out, matched } = redactText(text, "inbound");
  assert.equal(out, text);
  assert.equal(matched.JWT, undefined);
});

// --- FAILURE: lookalikes that must NOT fire (false-positive guard) -----------
test("failure: wall-clock, bare 10-digit, invalid Aadhaar, non-PAN left alone", () => {
  const text =
    "time 12:34:56 count 9876543210 fake-aadhaar 1234 5678 9012 label ABCD1234E";
  const { text: out, matched } = redactText(text, "inbound");

  assert.equal(out, text);
  assert.equal(matched.PHONE_US, undefined);
  assert.equal(matched.PHONE_IN, undefined);
  assert.equal(matched.AADHAAR, undefined);
  assert.equal(matched.PAN_IN, undefined);
  assert.equal(matched.JWT, undefined);
});

// --- EDGE: URL userinfo + https conn; sk-proj overlaps Bearer cleanly --------
test("edge: https userinfo redacts; sk-proj- matches API_KEY not Bearer alone", () => {
  const url = redactText("curl https://deploy:s3cret@api.example.com/v1", "inbound");
  assert.match(url.text, /\[REDACTED_PII_CONN_STRING\]/);
  assert.doesNotMatch(url.text, /deploy:s3cret@/);

  const key = redactText("key sk-proj-abcdefghijklmnopqrstuvwxyz012345", "inbound");
  assert.match(key.text, /\[REDACTED_PII_API_KEY\]/);
  assert.equal(key.matched.API_KEY, 1);
  assert.equal(key.matched.BEARER_TOKEN, undefined);
});
