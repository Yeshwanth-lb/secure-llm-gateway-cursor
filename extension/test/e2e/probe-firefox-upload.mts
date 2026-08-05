// Does the Phase Q/R upload guard work on FIREFOX?
//
// The guard leans on four platform APIs that Gecko has historically differed on,
// and guessing is not good enough for a security path. This probe launches a real
// Firefox (headless, throwaway profile, `about:blank` — no login, no network) and
// measures each one:
//
//   1. DecompressionStream/CompressionStream "deflate-raw" — the primitive the
//      whole zip.js reader/writer is built on. No deflate-raw ⇒ no Office scrub.
//   2. `new DataTransfer()` + assigning `input.files` — how the picker path
//      re-attaches the redacted file. No setter ⇒ no re-fire at all.
//   3. `new DragEvent("drop", { dataTransfer })` — the drag-and-drop re-fire.
//      Gecko is known to be fussy about constructed dataTransfer.
//   4. `new ClipboardEvent("paste", { clipboardData })` — the paste re-fire. The
//      guard ALREADY expects this to fail somewhere and degrades to a block; this
//      just tells us where.
//
// Run: npm run probe:firefox-upload

import { launchFirefox } from "./firefox-rdp.mts";
import { connectMarionette } from "./firefox-marionette.mts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A real page, because Firefox's RDP tab list does not expose `about:blank`.
// file:// keeps the probe offline: no server, no network, no login.
const dir = mkdtempSync(join(tmpdir(), "ff-upload-probe-"));
const pageFile = join(dir, "upload-probe.html");
writeFileSync(pageFile, "<!doctype html><title>upload probe</title><body>probe</body>");
const PAGE_URL = `file://${pageFile}`;

// ONE async script: Marionette gives each executeScript call its own sandbox, so
// stashing results on `window` and polling for them from a second call reads back
// nothing. The last argument of an ExecuteAsyncScript is the resolve callback.
const PROBE = `
(() => {
  const resolve = arguments[arguments.length - 1];
  const out = {};
  const done = () => resolve(JSON.stringify(out));

  // 2. DataTransfer + input.files setter
  try {
    const dt = new DataTransfer();
    dt.items.add(new File(["hello"], "a.txt", { type: "text/plain" }));
    const input = document.createElement("input");
    input.type = "file";
    input.files = dt.files;
    out.dataTransfer = input.files.length === 1 && input.files[0].name === "a.txt";
  } catch (e) { out.dataTransfer = "THREW: " + e.message; }

  // 3. DragEvent carrying a constructed DataTransfer
  try {
    const dt = new DataTransfer();
    dt.items.add(new File(["hello"], "b.txt", { type: "text/plain" }));
    const ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    out.dragEvent = !!ev.dataTransfer && ev.dataTransfer.files.length === 1;
  } catch (e) { out.dragEvent = "THREW: " + e.message; }

  // 4. ClipboardEvent carrying a constructed DataTransfer
  try {
    const dt = new DataTransfer();
    dt.items.add(new File(["hello"], "c.txt", { type: "text/plain" }));
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    out.clipboardEvent = !!ev.clipboardData && ev.clipboardData.files.length === 1;
  } catch (e) { out.clipboardEvent = "THREW: " + e.message; }

  // 1. deflate-raw round trip (async) — the basis of zip.js
  (async () => {
    try {
      const raw = new TextEncoder().encode("lorem ipsum ".repeat(200));
      const deflated = new Uint8Array(await new Response(
        new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))
      ).arrayBuffer());
      const back = new Uint8Array(await new Response(
        new Blob([deflated]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
      ).arrayBuffer());
      out.deflateRaw = deflated.length < raw.length &&
        new TextDecoder().decode(back) === new TextDecoder().decode(raw);
      out.deflateRawRatio = deflated.length + "/" + raw.length;
    } catch (e) { out.deflateRaw = "THREW: " + e.message; }

    // File.text()/arrayBuffer(), used to read an attachment before scanning.
    try {
      const f = new File(["dana"], "d.txt", { type: "text/plain" });
      out.fileText = (await f.text()) === "dana" && (await f.arrayBuffer()).byteLength === 4;
    } catch (e) { out.fileText = "THREW: " + e.message; }

    done();
  })();
})()
`;

const MARIONETTE_PORT = 2861;
const session = await launchFirefox({ url: PAGE_URL, headless: true, marionettePort: MARIONETTE_PORT });
let marionette: Awaited<ReturnType<typeof connectMarionette>> | undefined;
try {
  // Marionette, not the RDP tab list: a tab only becomes visible to RDP once
  // something navigates it, and Marionette is what does the navigating.
  marionette = await connectMarionette(MARIONETTE_PORT);
  await marionette.newSession();
  await marionette.navigate(PAGE_URL);

  const raw = await marionette.command("WebDriver:ExecuteAsyncScript", {
    script: PROBE,
    args: [],
    newSandbox: false,
    scriptTimeout: 20000,
  });
  const payload = raw?.value ?? raw;
  const out = typeof payload === "string" ? JSON.parse(payload) : payload || {};
  const rows: [string, unknown, string][] = [
    ["deflate-raw round trip (zip.js)", out.deflateRaw, "REQUIRED for the Office scrub"],
    ["File.text()/arrayBuffer()", out.fileText, "REQUIRED to read any attachment"],
    ["DataTransfer + input.files setter", out.dataTransfer, "REQUIRED for the file-picker re-fire"],
    ["DragEvent with dataTransfer", out.dragEvent, "needed for drag-and-drop re-fire"],
    ["ClipboardEvent with clipboardData", out.clipboardEvent, "paste re-fire (degrades to a block)"],
  ];
  console.log("\nFirefox upload-guard capability probe\n");
  for (const [name, value, note] of rows) {
    const ok = value === true;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` -> ${JSON.stringify(value)}`}\n        ${note}`);
  }
  if (out.deflateRawRatio) console.log(`\n  (deflate-raw compressed ${out.deflateRawRatio} bytes)`);

  const required = [out.deflateRaw, out.fileText, out.dataTransfer].every((v) => v === true);
  console.log(`\n${required ? "Core upload guard WORKS on Firefox." : "Core upload guard is BROKEN on Firefox."}\n`);
  if (!required) process.exit(1);
} finally {
  marionette?.close();
  session.close();
  rmSync(dir, { recursive: true, force: true });
}
