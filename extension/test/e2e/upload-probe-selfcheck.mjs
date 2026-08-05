// ===== UPLOAD PROBE SELF-CHECK (headless, zero-dep) =========================
// `upload-probe-console.js` is pasted into a live signed-in tab, so it cannot be
// exercised by the normal suite — but its `report().summary` is what a guard
// design gets decided on, so a wrong summary sends the next phase down the wrong
// road. Same reasoning as `scripts/selector-watch.mjs --self-check`: validate the
// probe itself headlessly.
//
// It replays synthetic traces through the REAL probe file and asserts the summary.
// The first trace is the ChatGPT flow measured live on 2026-07-30, whose answer is
// already known and shipped — so this doubles as a regression: the probe must keep
// reproducing `{host:"oaiusercontent.com", path:"/files/"}` and "bytes leave at
// attach time", the two findings the whole upload guard is built on.
//
// Run: npm run probe:upload-selfcheck
//
// This caught a real bug on first run: the `file-selected` row carries a
// File-shaped body by design, so it was being counted as its own upload request,
// making the first "upload" simultaneous with the attach and silently zeroing the
// attach→upload delta that the attach-vs-send conclusion rests on.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, "upload-probe-console.js");
const source = fs.readFileSync(PROBE, "utf8");

let failures = 0;
const check = (name, ok, got) => {
  if (ok) console.log(`  [OK]   ${name}`);
  else {
    failures++;
    console.error(`  [FAIL] ${name}\n         got: ${JSON.stringify(got)}`);
  }
};

/**
 * Install just enough browser surface for the probe to attach to, then eval it.
 * Returns the probe object plus the captured DOM listeners so a trace can drive
 * attach/drop/paste events.
 */
function armProbe(href) {
  const listeners = {};
  class FakeXHR {
    open() {}
    send() {}
  }
  const win = { fetch: function nativeFetch() {} };
  globalThis.window = win;
  globalThis.document = {
    addEventListener: (t, fn) => (listeners[t] = fn),
    removeEventListener: () => {},
  };
  globalThis.XMLHttpRequest = FakeXHR;
  globalThis.location = { href, origin: new URL(href).origin };
  Object.defineProperty(globalThis, "navigator", {
    // sendBeacon must exist for the probe to wrap it — Grok's telemetry uses it,
    // and an unwrapped beacon would make that trace unfaithful.
    value: { serviceWorker: { getRegistrations: async () => [] }, sendBeacon: () => true },
    configurable: true,
  });
  globalThis.FileReader = class {
    readAsDataURL() {}
    readAsText() {}
    readAsArrayBuffer() {}
    readAsBinaryString() {}
  };
  // eslint-disable-next-line no-eval -- dev self-check evaluating our own probe
  eval(source);
  return { probe: win.uploadProbe, listeners, win, XHR: FakeXHR };
}

const attachFile = (listeners, file) =>
  listeners.change({ target: { tagName: "INPUT", type: "file", files: [file] } });

// --- Trace 1: the real ChatGPT flow, whose answer is already known -----------
{
  console.log("chatgpt.com — raw File PUT at attach time (measured live 2026-07-30)");
  const { probe, listeners, win, XHR } = armProbe("https://chatgpt.com/");
  const file = new File([new Uint8Array(652)], "pii-sample.txt", { type: "text/plain" });

  attachFile(listeners, file);
  const xhr = new XHR();
  xhr.open("PUT", "https://sdmntprcentralindia.oaiusercontent.com/files/abc-123/raw");
  xhr.send(file);
  await new Promise((r) => setTimeout(r, 1200)); // stand-in for the real ~19s gap
  probe.mark("sent");
  win.fetch("https://chatgpt.com/backend-api/f/conversation", { method: "POST", body: '{"m":1}' });

  const { summary, uploads } = await probe.report();
  check("upload is reachable from page world", summary.reachableFromPage === true, summary.reachableFromPage);
  check("the attach event is not itself counted as an upload", uploads.length === 1, uploads.map((u) => u.url));
  check("body shape is a raw File", JSON.stringify(summary.bodyShapes) === '["File"]', summary.bodyShapes);
  check("today's guard shape covers it", uploads[0].guardShapeSupported === true, uploads[0]);
  check("bytes leave at ATTACH time, before the send", summary.leavesAtAttachTime === true, {
    msFromUploadToSend: summary.msFromUploadToSend,
  });
  check("no new guard work implied", summary.needsNewGuardWork === false, summary.needsNewGuardWork);
  check(
    "endpoint suggestion reproduces the shipped adapter entry",
    uploads[0].suggestedEndpoint.host === "oaiusercontent.com" && uploads[0].suggestedEndpoint.path === "/files/",
    uploads[0].suggestedEndpoint,
  );
  check(
    "the region-specific host is also reported verbatim",
    uploads[0].suggestedEndpoint.hostSeen === "sdmntprcentralindia.oaiusercontent.com",
    uploads[0].suggestedEndpoint,
  );
  check("page did not read the file itself", summary.pageReadTheFile === false, summary.pageReadTheFile);
  probe.stop();
}

// --- Trace 2: the real Grok flow, measured live 2026-07-31 -------------------
// Grok buries its upload in constant analytics: `Blob`s to /api/log_metric and
// 9-26 KB JSON strings to /_data/v1/a/t/, some of them BEFORE the attach. The
// first version of the summary ranked a beacon at 1413ms as "the first upload",
// producing a negative attach->upload gap and an attach-vs-send verdict that was
// correct only by accident. Timing must come from the real upload or not at all.
{
  console.log("grok.com — multipart FormData, buried in telemetry (measured live 2026-07-31)");
  const { probe, listeners, win, XHR } = armProbe("https://grok.com/");
  const file = new File([new Uint8Array(652)], "pii-sample.txt", { type: "text/plain" });

  // Telemetry BEFORE the attach — a Blob beacon and a fat JSON XHR.
  navigator.sendBeacon("https://grok.com/api/log_metric", new Blob([new Uint8Array(163)]));
  const pre = new XHR();
  pre.open("POST", "https://grok.com/_data/v1/a/t/");
  pre.send("x".repeat(1103));

  await new Promise((r) => setTimeout(r, 30));
  attachFile(listeners, file);
  const fd = new FormData();
  fd.append("file", file);
  win.fetch("https://grok.com/http/upload-file-v2/direct", { method: "POST", body: fd });

  // More telemetry after, including bodies far LARGER than the file — the exact
  // rows that used to be ranked as the upload.
  const post = new XHR();
  post.open("POST", "https://grok.com/_data/v1/a/t/");
  post.send("x".repeat(12581));
  navigator.sendBeacon("https://grok.com/api/log_metric", new Blob([new Uint8Array(3692)]));
  await new Promise((r) => setTimeout(r, 1200));
  probe.mark("sent");

  const { summary, uploads, weakCandidates } = await probe.report();
  check("the real upload is the only strong candidate", uploads.length === 1, uploads.map((u) => u.url));
  check(
    "it is the multipart POST, not a telemetry beacon",
    uploads[0].url === "https://grok.com/http/upload-file-v2/direct",
    uploads[0].url,
  );
  check("attach→upload gap is never negative", summary.msFromAttachToUpload >= 0, summary.msFromAttachToUpload);
  check("bytes still leave at attach time, before the send", summary.leavesAtAttachTime === true, {
    msFromUploadToSend: summary.msFromUploadToSend,
  });
  check(
    "an API version suffix is not mistaken for an id",
    uploads[0].suggestedEndpoint.path === "/http/upload-file-v2/",
    uploads[0].suggestedEndpoint,
  );
  check("host needs no suffix trick — Grok uploads same-origin", uploads[0].suggestedEndpoint.host === "grok.com", uploads[0].suggestedEndpoint);
  check("multipart is flagged as new guard work", summary.needsNewGuardWork === true, summary.needsNewGuardWork);
  check("one endpoint reported, not one row per retry", summary.candidateEndpoints.length === 1, summary.candidateEndpoints);
  check("the telemetry is kept visible rather than dropped", weakCandidates.length >= 2, weakCandidates.length);
  probe.stop();
}

// --- Trace 3: multipart FormData — a shape the current guard does NOT handle --
{
  console.log("hypothetical surface — multipart FormData upload");
  const { probe, listeners, win } = armProbe("https://grok.com/");
  const file = new File([new Uint8Array(652)], "pii-sample.txt", { type: "text/plain" });
  attachFile(listeners, file);
  const fd = new FormData();
  fd.append("file", file);
  fd.append("conversationId", "abc");
  win.fetch("https://grok.com/rest/app-chat/upload-file", { method: "POST", body: fd });

  const { summary, uploads } = await probe.report();
  check("multipart is recognised as carrying the file", JSON.stringify(summary.bodyShapes) === '["FormData"]', summary.bodyShapes);
  check("flagged as NOT covered by today's guard", uploads[0].guardShapeSupported === false, uploads[0]);
  check(
    "suggested path is specific, not a host-wide prefix like /rest/",
    uploads[0].suggestedEndpoint.path === "/rest/app-chat/",
    uploads[0].suggestedEndpoint,
  );
  check(
    "the observed path is reported in full alongside the heuristic",
    uploads[0].suggestedEndpoint.pathFull === "/rest/app-chat/upload-file",
    uploads[0].suggestedEndpoint,
  );
  check("summary says new guard work is needed", summary.needsNewGuardWork === true, summary.needsNewGuardWork);
  check("field and file names captured, content never read", uploads.length === 1 && uploads[0].bodyKind === "FormData", uploads[0]);
  probe.stop();
}

// --- Trace 3: the page reads the file and inlines it (base64 in JSON) --------
{
  console.log("hypothetical surface — file read by the page, inlined into JSON");
  const { probe, listeners, win } = armProbe("https://grok.com/");
  const file = new File([new Uint8Array(652)], "pii-sample.txt", { type: "text/plain" });
  attachFile(listeners, file);
  new FileReader().readAsDataURL(file); // page re-encodes it itself
  win.fetch("https://grok.com/rest/app-chat/conversations/new", {
    method: "POST",
    body: JSON.stringify({ message: "hi", attachment: "x".repeat(4000) }),
  });

  const { summary } = await probe.report();
  check("the page reading the file is detected", summary.pageReadTheFile === true, summary.pageReadTheFile);
  check("an oversized string body is flagged as a possible inline upload", summary.bodyShapes.includes("string?"), summary.bodyShapes);
  check("summary says new guard work is needed", summary.needsNewGuardWork === true, summary.needsNewGuardWork);
  probe.stop();
}

// --- Trace 4: nothing reachable — the "cannot be guarded this way" answer ----
{
  console.log("hypothetical surface — no page-world upload seen");
  const { probe, listeners } = armProbe("https://grok.com/");
  attachFile(listeners, new File([new Uint8Array(10)], "a.txt", { type: "text/plain" }));

  const { summary } = await probe.report();
  check("reports the upload as NOT reachable from page world", summary.reachableFromPage === false, summary.reachableFromPage);
  check("no endpoint is invented from an absent request", summary.candidateEndpoints.length === 0, summary.candidateEndpoints);
  check("timing is null rather than a misleading zero", summary.firstUploadAtMs === null, summary.firstUploadAtMs);
  probe.stop();
}

// --- Trace 6: file-shaped traffic, but nothing that matches the file ---------
// The dangerous middle ground. Ranking can be wrong in both directions, and if a
// real upload gets ranked weak, a bare `reachableFromPage: false` reads as
// "nothing to guard here" — the worst possible misreading. It must say so.
{
  console.log("hypothetical surface — file-shaped traffic that matches nothing");
  const { probe, listeners, win } = armProbe("https://grok.com/");
  attachFile(listeners, new File([new Uint8Array(652)], "pii-sample.txt", { type: "text/plain" }));
  win.fetch("https://grok.com/_data/v1/a/t/", { method: "POST", body: "x".repeat(50000) });

  const { summary, uploads, weakCandidates } = await probe.report();
  check("nothing is promoted to a strong candidate", uploads.length === 0, uploads);
  check("the ambiguity is reported as INCONCLUSIVE", summary.inconclusive === true, summary.inconclusive);
  check("the unmatched traffic is still listed for inspection", weakCandidates.length === 1, weakCandidates.length);
  probe.stop();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nupload probe self-check: all checks passed");
process.exit(failures ? 1 : 0);
