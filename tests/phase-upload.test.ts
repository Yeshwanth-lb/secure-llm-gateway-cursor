// ===== PHASE Q — FILE-UPLOAD GUARD (pure core) ==============================
// Attaching a file to ChatGPT was a total bypass: the composer interceptor never
// sees it, and the upload does not go to the conversation endpoint the tripwire
// inspects. Probed live 2026-07-30 (`extension/test/e2e/upload-probe-console.js`,
// findings in extension/CHATGPT_COVERAGE.md §6):
//
//   file-selected  input.change   pii-sample.txt  652 B  text/plain
//   xhr PUT  https://sdmntprcentralindia.oaiusercontent.com/files/<id>/raw
//            body: File
//   fetch POST https://chatgpt.com/backend-api/f/conversation   (19s LATER)
//
// Two facts drive this module:
//   1. The bytes leave at ATTACH time, ~19s before the message is sent — so the
//      guard must run on the change/drop/paste event, not at submit. (It also
//      means attaching a file and REMOVING it before sending already leaked it.)
//   2. The upload host is REGION-SPECIFIC (`sdmntprcentralindia…`), so URL
//      matching must key on `oaiusercontent.com` + `/files/` + `/raw`.
//
// The hard ceiling, decided deliberately: text-like files can be scrubbed, but
// PDF/DOCX/XLSX/images CANNOT be parsed without adding dependencies, and zero
// runtime dependencies is a project constraint. Those are therefore BLOCKED —
// fail-closed, consistent with every other unreadable path in this project.
//
// This file covers the pure decision core only. The DOM kill-and-re-fire and the
// tripwire backstop are browser-gated (`npm run test:chatgpt-e2e`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyFile,
  decideUpload,
  isUploadUrl,
  uploadBlobsOf,
  MAX_SCAN_BYTES,
} from "../extension/src/upload-core.js";
import { CHATGPT_ADAPTER, GEMINI_ADAPTER, GROK_ADAPTER } from "../extension/src/site-adapter.js";

const EMAIL = "dana" + "@" + "corp.example";
const RAW = `contact: ${EMAIL}`;
const REDACTED = "contact: [REDACTED_PII_EMAIL]";

const file = (name: string, type: string, size = 100) => ({ name, type, size });

// The exact URL shape observed live, with the region-specific host.
const PUT_URL = "https://sdmntprcentralindia.oaiusercontent.com/files/00000000-ced8-8208-ba86-ab25a225f6b3/raw";

// --- happy ------------------------------------------------------------------
test("happy: a text file containing PII is replaced with its redacted text", () => {
  const decision = decideUpload({
    file: file("pii-sample.txt", "text/plain", 652),
    text: RAW,
    redaction: { ok: true, redacted: REDACTED, piiDetected: true },
  });
  assert.equal(decision.action, "replace");
  assert.equal(decision.text, REDACTED);
  assert.ok(!decision.text.includes(EMAIL), "the replacement must not carry raw PII");
});

// --- failure ----------------------------------------------------------------
test("failure: unscannable formats are BLOCKED, and so is a text file the gateway could not redact", () => {
  // NB: .docx/.xlsx/.pptx are NOT here — Phase R reads them (zip + XML) and
  // scrubs them. The legacy binary .doc/.xls/.ppt are a different format and stay
  // blocked, as does anything we cannot parse without a dependency.
  for (const f of [
    file("report.pdf", "application/pdf", 2048),
    file("legacy.xls", "application/vnd.ms-excel"),
    file("photo.png", "image/png"),
    file("scan.jpeg", "image/jpeg"),
    file("archive.zip", "application/zip"),
    file("clip.mp4", "video/mp4"),
  ]) {
    const d = decideUpload({ file: f, text: null, redaction: null });
    assert.equal(d.action, "block", `${f.name} must be blocked`);
    assert.equal(d.reason, "upload-unscannable");
  }

  // Gateway down on a scannable file must FAIL CLOSED, never fall through.
  const dead = decideUpload({
    file: file("notes.txt", "text/plain"),
    text: RAW,
    redaction: { ok: false },
  });
  assert.equal(dead.action, "block");
  assert.equal(dead.reason, "gateway-unreachable");

  // A gateway that answers ok but returns nothing usable is also a block, not an
  // "allow" — an undefined `redacted` must never be written back as the file.
  for (const redaction of [{ ok: true }, { ok: true, redacted: null }, { ok: true, redacted: 123 as any }]) {
    const d = decideUpload({ file: file("notes.txt", "text/plain"), text: RAW, redaction });
    assert.equal(d.action, "block", JSON.stringify(redaction));
    assert.equal(d.reason, "gateway-unreachable");
  }
});

// --- edge -------------------------------------------------------------------
test("edge: clean text passes untouched; extension beats a mislabeled MIME type; oversized text is blocked", () => {
  // No PII -> upload the ORIGINAL file. Re-wrapping a clean file would be a
  // pointless behavior change (and would drop metadata for no benefit).
  const clean = decideUpload({
    file: file("readme.md", "text/markdown"),
    text: "nothing sensitive here",
    redaction: { ok: true, redacted: "nothing sensitive here", piiDetected: false },
  });
  assert.equal(clean.action, "allow");
  assert.equal(clean.reason, "no-pii");

  // Browsers often report an empty type for less common extensions: classify by
  // extension so a .md/.csv/.json file is still scrubbed rather than blocked.
  assert.equal(classifyFile(file("data.csv", "")).scannable, true);
  assert.equal(classifyFile(file("conf.yaml", "")).scannable, true);
  assert.equal(classifyFile(file("main.py", "application/octet-stream")).scannable, true);

  // THE TRAP: a binary extension with a text-ish MIME type must still be blocked.
  // MIME is attacker/OS-controlled metadata; treating it as authoritative would
  // hand a PDF to a text scan, "find" no PII, and upload it raw.
  const spoofed = classifyFile(file("payroll.pdf", "text/plain"));
  assert.equal(spoofed.scannable, false);
  assert.equal(spoofed.reason, "binary-extension");

  // A file with no extension and no type is unknown -> not scannable (fail-closed).
  assert.equal(classifyFile(file("attachment", "")).scannable, false);

  // Too big to scan is treated as unscannable rather than scanned partially.
  const huge = classifyFile(file("dump.txt", "text/plain", MAX_SCAN_BYTES + 1));
  assert.equal(huge.scannable, false);
  assert.equal(huge.reason, "too-large");
  assert.equal(classifyFile(file("dump.txt", "text/plain", MAX_SCAN_BYTES)).scannable, true);

  // An empty file has nothing to leak, so it must not be blocked as "unreadable".
  const empty = decideUpload({
    file: file("empty.txt", "text/plain", 0),
    text: "",
    redaction: { ok: true, redacted: "", piiDetected: false },
  });
  assert.equal(empty.action, "allow");

  // Scannable but unreadable (FileReader failed) is a block: we cannot prove it clean.
  const unreadable = decideUpload({ file: file("notes.txt", "text/plain"), text: null, redaction: null });
  assert.equal(unreadable.action, "block");
  assert.equal(unreadable.reason, "upload-unreadable");
});

test("edge: upload-URL matching survives the region-specific host and ignores telemetry", () => {
  const eps = CHATGPT_ADAPTER.uploadEndpoints;
  assert.ok(Array.isArray(eps) && eps.length > 0, "ChatGPT adapter must declare uploadEndpoints");
  assert.equal(isUploadUrl(PUT_URL, eps), true);
  // A different OpenAI region must match too — this is why the host itself is
  // never hard-coded.
  assert.equal(isUploadUrl(PUT_URL.replace("centralindia", "eastus"), eps), true);

  // Must NOT swallow unrelated traffic: telemetry was the false-positive class
  // that once forced the tripwire off entirely.
  for (const url of [
    "https://chatgpt.com/ces/v1/t",
    "https://chatgpt.com/ces/statsc/flush",
    "https://ab.chatgpt.com/v1/rgstr",
    "https://chatgpt.com/backend-api/me",
    "https://chatgpt.com/backend-api/f/conversation",
  ]) {
    assert.equal(isUploadUrl(url, eps), false, url);
  }

  // Gemini's uploads were probed live 2026-08-03 (Blob POST to
  // push.clients6.google.com/upload/) and armed. The endpoint must match that
  // upload URL and nothing else Gemini fires (analytics / batchexecute / logs).
  assert.equal(GEMINI_ADAPTER.uploadGuard, true);
  assert.deepEqual(GEMINI_ADAPTER.uploadEndpoints, [{ host: "clients6.google.com", path: "/upload/" }]);
  assert.ok(isUploadUrl("https://push.clients6.google.com/upload/", GEMINI_ADAPTER.uploadEndpoints));
  for (const url of [
    "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
    "https://gemini.google.com/_/BardChatUi/data/batchexecute",
    "https://play.google.com/log",
    "https://www.google-analytics.com/g/collect",
  ]) {
    assert.equal(isUploadUrl(url, GEMINI_ADAPTER.uploadEndpoints), false, url);
  }
  assert.equal(CHATGPT_ADAPTER.uploadGuard, true);
});

// ===== GROK — MULTIPART UPLOADS (probed live 2026-07-31) ====================
// Grok's flow, measured twice with `upload-probe-console.js`:
//
//   file-selected  input.change  pii-sample.txt  652 B  text/plain
//   fetch POST https://grok.com/http/upload-file-v2/direct
//              body: FormData -> [{ field:"file", File "pii-sample.txt", 652 B }]
//   mark "sent"                                            (~24s LATER)
//
// Same attach-time conclusion as ChatGPT, only tighter (35ms vs 259ms). Two
// differences drive the code below:
//   1. The body is multipart FORMDATA, not a raw File, so `isBinaryBody` — which
//      only recognises a Blob — cannot see it and the backstop would read nothing.
//   2. It is issued with FETCH, whereas ChatGPT used XHR. The wire-level backstop
//      was only ever wired into `XHR.send`, so without a fetch-side branch Grok's
//      uploads have NO backstop at all, whatever the body shape.
// The attach-time DOM guard needs no change: it swaps a redacted File into
// `input.files`/DataTransfer, and the page then builds its own body from that.

test("happy: a multipart upload body yields its files for scanning", async () => {
  const fd = new FormData();
  fd.append("file", new File([RAW], "notes.txt", { type: "text/plain" }));

  const blobs = uploadBlobsOf(fd);
  assert.equal(blobs.length, 1, "the File part must be found");
  assert.equal(await blobs[0].text(), RAW);

  // A raw Blob/File body (ChatGPT's shape) must keep working through the same call.
  const raw = new File([RAW], "notes.txt", { type: "text/plain" });
  const rawBlobs = uploadBlobsOf(raw);
  assert.equal(rawBlobs.length, 1);
  assert.equal(await rawBlobs[0].text(), RAW);
});

test("failure: bodies with nothing readable yield nothing rather than throwing", () => {
  // A backstop that throws on an unexpected body shape would break every upload
  // on the surface, so each of these must degrade to "nothing to scan".
  for (const body of [null, undefined, "", "plain string", 42, {}, new URLSearchParams("a=1")]) {
    assert.deepEqual(uploadBlobsOf(body as never), [], String(body));
  }

  // Multipart carrying only text fields has no file to scan.
  const textOnly = new FormData();
  textOnly.append("conversationId", "abc-123");
  assert.deepEqual(uploadBlobsOf(textOnly), []);
});

test("edge: several file parts are all scanned, and text fields are skipped", async () => {
  // A multi-file attach must not be judged on its first part alone: PII in the
  // second file would sail past a first-part-only backstop.
  const fd = new FormData();
  fd.append("conversationId", "abc-123");
  fd.append("file", new File(["clean"], "a.txt", { type: "text/plain" }));
  fd.append("file2", new File([RAW], "b.txt", { type: "text/plain" }));

  const blobs = uploadBlobsOf(fd);
  assert.equal(blobs.length, 2, "both files, and not the text field");
  const texts = await Promise.all(blobs.map((b) => b.text()));
  assert.deepEqual(texts, ["clean", RAW]);
});

test("edge: Grok's upload endpoint matches its real URL and no other Grok traffic", () => {
  const eps = GROK_ADAPTER.uploadEndpoints;
  assert.ok(Array.isArray(eps) && eps.length > 0, "Grok adapter must declare uploadEndpoints");
  assert.equal(isUploadUrl("https://grok.com/http/upload-file-v2/direct", eps), true);

  // Everything else seen in the probe's 91-request capture. `/api/log_metric` and
  // `/_data/v1/a/t/` are the analytics that carry Blobs and fat JSON — the exact
  // false-positive class that once forced the tripwire off entirely.
  for (const url of [
    "https://grok.com/api/log_metric",
    "https://grok.com/_data/v1/a/t/",
    "https://grok.com/cdn-cgi/rum",
    "https://grok.com/rest/rate-limits",
    "https://grok.com/rest/skills",
    "https://grok.com/rest/connectors/list-v2",
    "https://grok.com/rest/app-chat/conversations/014bfd2b-3a96-4cbf-8131-f76dbd4910e2/load-responses",
  ]) {
    assert.equal(isUploadUrl(url, eps), false, url);
  }

  // Grok's uploads must not be matched by ChatGPT's endpoints or vice versa —
  // host scoping is the security property that keeps one surface's change from
  // silently arming or disarming another.
  assert.equal(isUploadUrl("https://grok.com/http/upload-file-v2/direct", CHATGPT_ADAPTER.uploadEndpoints), false);
  assert.equal(isUploadUrl(PUT_URL, eps), false);

  assert.equal(GROK_ADAPTER.uploadGuard, true);
});

test("failure: the uploadPolicy escape hatch is actually REACHABLE from storage", () => {
  // A settings knob that cannot be set is not a knob. `upload-guard.js` implements
  // `policy: "warn"` and `content-main.js` reads `CONFIG.uploadPolicy`, but the
  // value has to cross the isolated->MAIN bridge, and the bridge only relays keys
  // named in its CONFIG_KEYS list. `uploadPolicy` was missing from it, so the
  // documented escape hatch silently did nothing in a real browser: storage was
  // read, the key was dropped, and MAIN kept the default "block".
  //
  // Nothing caught that because every other test sets config by dispatching the
  // MAIN-world event DIRECTLY, bypassing the bridge — so this asserts on the
  // bridge source, which is the only place the omission is visible.
  const bridge = readFileSync(new URL("../extension/src/content-bridge.js", import.meta.url), "utf8");
  const keys = /const CONFIG_KEYS = \[(.*?)\]/s.exec(bridge);
  assert.ok(keys, "content-bridge.js must declare CONFIG_KEYS");
  const relayed = keys[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));

  // Read by content-main.js, so each must be relayed or it is dead config.
  const main = readFileSync(new URL("../extension/src/content-main.js", import.meta.url), "utf8");
  for (const key of ["uploadPolicy", "uploadGuard"]) {
    assert.ok(main.includes(`CONFIG.${key}`), `content-main.js should read CONFIG.${key}`);
    assert.ok(relayed.includes(key), `content-bridge.js CONFIG_KEYS must relay "${key}" or it can never be set`);
  }
});
