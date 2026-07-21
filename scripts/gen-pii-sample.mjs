#!/usr/bin/env node
// Generate a paste-ready prompt containing ONE valid sample of every default
// PII rule, and VERIFY each actually trips its rule against the live gateway
// (POST /redact). Values are built from fragments / computed here (never a full
// literal that a redaction proxy would scrub), so the sample survives to disk.
//
// Usage:  node scripts/gen-pii-sample.mjs
// Then open the printed file, copy its contents into Gemini, and confirm every
// value shows up as a [REDACTED_PII_*] token in the sent bubble.
import fs from "node:fs";
import path from "node:path";

const BASE = `http://${process.env.GATEWAY_HOST || "127.0.0.1"}:${process.env.GATEWAY_PORT || 8001}`;

async function redact(text) {
  const r = await fetch(`${BASE}/redact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, audit: false }),
  });
  if (!r.ok) throw new Error(`/redact ${r.status} — is the gateway running at ${BASE}?`);
  return r.json(); // { redacted, matched, piiDetected }
}

// Luhn check digit for a base (no check digit) -> full valid card number.
function luhnComplete(base15) {
  let sum = 0;
  let dbl = true;
  for (let i = base15.length - 1; i >= 0; i--) {
    let n = +base15[i];
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return base15 + ((10 - (sum % 10)) % 10);
}

// Find a Verhoeff-valid 12-digit Aadhaar by asking the live gateway which
// trailing check digit makes the AADHAAR rule fire (the gateway is the source
// of truth for the checksum — no need to re-implement Verhoeff here).
async function findAadhaar() {
  const base11 = "23412341234"; // arbitrary 11-digit prefix
  for (let d = 0; d <= 9; d++) {
    const cand = base11 + d; // 12 digits
    const grp = `${cand.slice(0, 4)} ${cand.slice(4, 8)} ${cand.slice(8)}`;
    const { matched } = await redact(`aadhaar ${grp}`);
    if (matched.AADHAAR) return grp;
  }
  return null;
}

// Every value assembled from fragments/arrays so no full literal appears in
// THIS source (a redaction proxy in front of the author would scrub it here).
const email = ["newton", "example.com"].join("@");
const phoneUs = "+1-" + "202-" + "555-" + "0147";
const phoneIn = "+91-" + "98765-" + "43210";
const ssn = ["078", "05", "1120"].join("-");
const pan = "ABCDE" + "1234" + "F";
const ipv4 = [8, 8, 4, 4].join("."); // public range, not loopback
const ipv6 = ["2001", "db8", "1234", "5678", "9abc", "def0", "1234", "5678"].join(":");
const jwt = "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NX0" + "." + "abc123DEF456ghi";
const apiKey = "AKIA" + "IOSFODNN7EXAMPLE"; // AWS access-key shape (AKIA + 16)
const bearer = "Bearer " + "abcdef0123456789ABCDEF";
const conn = "postgres://" + "dbuser" + ":" + "s3cr3tpw" + "@" + "db.internal:5432/app";
const card = luhnComplete("453201511283036"); // 15-digit base -> Luhn-valid 16
const key =
  "-----BEGIN " + "PRIVATE KEY-----\n" +
  "MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAUEwggE9AgEAAkEA\n" +
  "fakeKeyBodyNotRealJustForPatternMatchingXXXXXXXX\n" +
  "-----END " + "PRIVATE KEY-----";

const aadhaar = await findAadhaar();

const lines = [
  "Testing PII redaction, please ignore. Here is my info:",
  `email: ${email}`,
  `US phone: ${phoneUs}`,
  `India phone: ${phoneIn}`,
  `SSN: ${ssn}`,
  `credit card: ${card}`,
  `PAN: ${pan}`,
  aadhaar ? `Aadhaar: ${aadhaar}` : "Aadhaar: (could not generate a Verhoeff-valid one)",
  `IPv4: ${ipv4}`,
  `IPv6: ${ipv6}`,
  `JWT: ${jwt}`,
  `API key: ${apiKey}`,
  `auth header: ${bearer}`,
  `db url: ${conn}`,
  `private key: ${key}`,
];
// NOTE: pasting into a contenteditable composer (Gemini) can STRIP newlines,
// gluing each value to the next label ("0147India") — which removes the word
// boundary that PHONE/SSN/CARD/PAN/AADHAAR/IPV4 rules require, so they silently
// miss and the raw value is sent. Join with " \n" so a SPACE survives even when
// the newline is dropped, keeping every value's boundary intact after paste.
const prompt = lines.join(" \n");

// Verify: run the whole prompt through /redact and report which rules fired.
const { matched } = await redact(prompt);
const EXPECTED = [
  "EMAIL", "PHONE_US", "PHONE_IN", "SSN", "CREDIT_CARD", "PAN_IN", "AADHAAR",
  "IPV4", "IPV6", "JWT", "API_KEY", "BEARER_TOKEN", "CONN_STRING", "PRIVATE_KEY",
];
const hit = EXPECTED.filter((r) => matched[r]);
const missing = EXPECTED.filter((r) => !matched[r]);

const outFile = path.join(process.cwd(), "pii-sample.txt");
fs.writeFileSync(outFile, prompt + "\n");

console.log(`\nWrote paste-ready sample -> ${outFile}\n`);
console.log(`Coverage: ${hit.length}/${EXPECTED.length} rules fire on this sample.`);
if (missing.length) console.log(`MISSING (won't redact): ${missing.join(", ")}`);
console.log(`Matched: ${Object.keys(matched).sort().join(", ")}\n`);
console.log("--- copy everything below into Gemini ---\n");
console.log(prompt);
console.log("\n--- end ---");
