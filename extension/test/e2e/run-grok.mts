// ===== GROK SURFACE — Playwright e2e (send path + shape-based reply capture) ==
// Drives the REAL content-main.js / composer.js / site-adapter.js / tripwire.js
// in real Chromium against fake-grok.html (which reproduces Grok's Tiptap/
// ProseMirror composer, its UNLABELED submit button, the stop button, and a
// reply built from class-name-free `animate-gaussian` word spans) backed by the
// REAL gateway.
//
//   HAPPY    a prompt containing PII leaves as a redacted TOKEN in the `message`
//            field of the /rest/app-chat/conversations/ POST, with zero raw PII,
//            exactly ONE send and ONE gateway call, and the turn is logged as
//            provider "openai" / source "grok-web-extension" — with the reply
//            recovered by SHAPE, since Grok has no semantic reply selector.
//   FAILURE  the gateway is unreachable -> NOTHING is sent (fail closed) and the
//            user is told.
//   EDGE     (a) clicking Grok's UNLABELED `button[type=submit]` is intercepted
//            too — none of the generic aria/testid selectors match it, so this is
//            the path that would silently skip redaction; and (b) an editor whose
//            model refuses programmatic edits -> the DOM path cannot redact, so
//            the G4 tripwire ABORTS: still no raw PII on the wire.
//
// The PII value is assembled at runtime so no PII literal lives in this file.
//
// Run: npm run test:grok-e2e   (needs `npx playwright install chromium`)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { createGatewayServer } from "../../../secure-llm-gateway.ts";
import { readZip, writeZip } from "../../src/zip.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, "../..");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

const PII_EMAIL = "casey.tester" + "@" + "example.com";
const TOKEN = "[REDACTED_PII_EMAIL]";
const PROMPT = `Summarize the thread and reply to ${PII_EMAIL}`;
// Grok's message POST. The fixture posts to this path on the page's own origin,
// so the tripwire's endpoint scoping is exercised for real. The adapter matches
// the shared PREFIX `/rest/app-chat/conversations/`, which also covers the
// per-conversation `/{id}/load-responses` path.
const CONVERSATION_PATH = "/rest/app-chat/conversations/new";
// Grok's upload endpoint, confirmed live 2026-07-31: multipart FormData POSTed
// with `fetch` 35ms after the attach, ~24s BEFORE the message is sent. Unlike
// ChatGPT's it is same-origin, so the fixture posts to this path directly.
const UPLOAD_PATH = "/http/upload-file-v2/direct";

/**
 * A minimal but real .docx, built here so the test stays hermetic (no generated
 * file on disk to go stale). The PII is SPLIT ACROSS RUNS exactly as Word stores
 * it, which is the case a per-run scan misses — a fixture with each value in one
 * run would pass even with the paragraph concatenation broken.
 */
async function docxBytes(): Promise<Buffer> {
  const enc = (s: string) => new TextEncoder().encode(s);
  const paragraphs = [
    ["Client contact: ", "casey.tester", "@exam", "ple.com"],
    ["This paragraph has no sensitive data and must come back untouched."],
  ];
  const body = paragraphs
    .map((runs) => `<w:p>${runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join("")}</w:p>`)
    .join("");
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return Buffer.from(
    await writeZip([
      { name: "[Content_Types].xml", data: enc(types) },
      { name: "_rels/.rels", data: enc(rels) },
      { name: "word/document.xml", data: enc(doc) },
    ]),
  );
}

/**
 * Pull a ZIP out of a single-file multipart body and read its document.xml back.
 *
 * Needed because the uploaded .docx is DEFLATED: decoding those bytes as text and
 * grepping them proves nothing about the XML inside, so an assertion on the string
 * form would be a false pass. Slicing from the local-file-header signature to the
 * closing boundary is enough here — one file part per request, as Grok sends it.
 */
async function docxTextFromMultipart(body: Buffer): Promise<string> {
  const start = body.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])); // "PK\x03\x04"
  if (start < 0) return "";
  const end = body.lastIndexOf(Buffer.from("\r\n--", "utf8"));
  const entries = await readZip(body.subarray(start, end > start ? end : undefined));
  const doc = entries.find((e) => e.name === "word/document.xml");
  return doc ? new TextDecoder().decode(doc.data) : "";
}

/**
 * Serve the extension tree (so the page can import the real modules) and answer
 * the fake conversation endpoint.
 */
function startStatic(): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === CONVERSATION_PATH || url.pathname === UPLOAD_PATH) {
      req.resume(); // drain, as the real endpoint would
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    const rel = url.pathname === "/" ? "/test/e2e/fake-grok.html" : url.pathname;
    const file = path.join(EXT_ROOT, rel);
    if (!file.startsWith(EXT_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "text/plain" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

type Turn = { prompt: string; response: string; model: string; provider: string; source: string };
type PageWindow = { __sent__: string[]; __logged__: Turn[]; __blocked__: string[] };

/**
 * Open the fake page, type PROMPT with real keystrokes, submit, and report what
 * crossed the wire plus what the extension logged.
 *
 * `gatewayBase` is pointed at a dead port for the fail-closed case. `stale`
 * selects the editor that refuses programmatic edits. `submit` chooses the
 * gesture: Enter, or a real mouse click on the unlabeled submit button.
 */
async function sendOneTurn(
  browser: Browser,
  pageBase: string,
  gatewayBase: string,
  opts: { stale?: boolean; waitForLog?: boolean; submit?: "enter" | "click" } = {},
) {
  const page: Page = await browser.newPage();
  const wireBodies: string[] = [];
  const gatewayCalls: string[] = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.pathname === CONVERSATION_PATH) wireBodies.push(req.postData() || "");
    if (u.pathname === "/redact" || u.pathname === "/log-turn") gatewayCalls.push(u.pathname);
  });
  try {
    const qs = new URLSearchParams({ base: gatewayBase });
    if (opts.stale) qs.set("stale", "1");
    await page.goto(`${pageBase}/?${qs}`);
    // `site` forces the Grok adapter: the fixture is served from 127.0.0.1, so
    // the hostname cannot select it the way grok.com does in production.
    await page.evaluate(
      (cfg) => window.dispatchEvent(new CustomEvent("gemini-redact:config", { detail: cfg })),
      { site: "grok", settleMs: 500, turnTimeoutMs: 12000, tripwire: true, base: gatewayBase },
    );
    const box = page.locator("#editor");
    await box.click();
    await box.type(PROMPT, { delay: 5 });
    if (opts.submit === "click") await page.locator("#send").click();
    else await page.keyboard.press("Enter");
    if (opts.waitForLog !== false) {
      await page
        .waitForFunction(() => (window as unknown as PageWindow).__logged__.length > 0, null, { timeout: 16000 })
        .catch(() => {});
    } else {
      await page.waitForTimeout(4000);
    }
    const state = await page.evaluate(() => {
      const w = window as unknown as PageWindow & { __aborted__?: string };
      return {
        sent: w.__sent__,
        logged: w.__logged__,
        blocked: w.__blocked__,
        aborted: w.__aborted__ || "",
        decoyText: (document.getElementById("decoy") as HTMLElement).innerText,
      };
    });
    return { ...state, wireBodies, gatewayCalls };
  } finally {
    await page.close();
  }
}

/**
 * Attach a file (or trigger a raw bypass upload) and report what reached the wire.
 *
 * Grok's upload endpoint is on its OWN origin, so unlike ChatGPT's region-sharded
 * `*.oaiusercontent.com` there is no cross-host route to intercept — the static
 * server just has to answer it, and Playwright records the multipart body.
 */
async function attachFile(
  browser: Browser,
  pageBase: string,
  gatewayBase: string,
  opts: {
    name?: string;
    mimeType?: string;
    body?: string;
    rawUpload?: string;
    via?: "picker" | "drop";
    /** Several files in ONE attach, which is a different path: the guard decides each
     *  separately and must reassemble them in order, all-or-nothing. */
    files?: { name: string; mimeType: string; buffer: Buffer }[];
    /** "warn" is the escape hatch for people who must attach real work files. */
    uploadPolicy?: "block" | "warn";
  },
) {
  const page: Page = await browser.newPage();
  const uploadBodies: string[] = [];
  // Kept alongside the string form: a deflated .docx cannot be checked as text, so
  // an assertion about its CONTENT needs the bytes.
  const uploadBuffers: Buffer[] = [];
  // The fixture posts to the REAL grok.com upload URL so the adapter's
  // `{host:"grok.com"}` match is exercised for real, and Playwright fulfils it
  // locally so no external request is made. Routing on the host (not the path)
  // also proves nothing else on grok.com is being hit.
  await page.route("**://grok.com/**", async (route) => {
    // postDataBuffer, not postData: a multipart body is binary-framed and the
    // file's bytes sit inside it after the part headers.
    const raw = route.request().postDataBuffer() ?? Buffer.alloc(0);
    uploadBuffers.push(raw);
    uploadBodies.push(raw.toString("utf8"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      // The page fetches cross-origin, so without CORS the response is unreadable
      // and the fixture would record a spurious upload error.
      headers: { "access-control-allow-origin": "*" },
      body: "{}",
    });
  });
  try {
    await page.goto(`${pageBase}/?${new URLSearchParams({ base: gatewayBase })}`);
    await page.evaluate(
      (cfg) => window.dispatchEvent(new CustomEvent("gemini-redact:config", { detail: cfg })),
      {
        site: "grok",
        settleMs: 500,
        turnTimeoutMs: 12000,
        tripwire: true,
        base: gatewayBase,
        ...(opts.uploadPolicy ? { uploadPolicy: opts.uploadPolicy } : {}),
      },
    );

    if (opts.rawUpload !== undefined) {
      await page.evaluate((t) => (window as any).__rawUpload__(t), opts.rawUpload);
    } else if (opts.files) {
      await page.setInputFiles("#file-input", opts.files);
    } else if (opts.via === "drop") {
      // Playwright cannot drag a file in from the OS, so the drop is constructed
      // in the page. That is still a fair exercise of the guard: it keys off its
      // own SYNTHETIC marker rather than `isTrusted`, so this event takes exactly
      // the path a real drop takes. (The composer's loop guard DOES check
      // `isTrusted` — the upload guard deliberately must not, or the re-fire it
      // dispatches itself would be re-guarded forever.)
      await page.evaluate(
        ({ name, mimeType, body }) => {
          const dt = new DataTransfer();
          dt.items.add(new File([body], name, { type: mimeType }));
          document
            .getElementById("drop-zone")!
            .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        },
        { name: opts.name!, mimeType: opts.mimeType!, body: opts.body! },
      );
    } else {
      await page.setInputFiles("#file-input", {
        name: opts.name!,
        mimeType: opts.mimeType!,
        buffer: Buffer.from(opts.body!, "utf8"),
      });
    }
    // The guard reads the file, calls the gateway, re-fires a synthetic change,
    // and the tripwire backstop awaits an async read of every multipart part.
    await page.waitForTimeout(2500);

    const state = await page.evaluate(() => {
      const w = window as any;
      return {
        uploads: w.__uploads__ || [],
        blocked: w.__blocked__ || [],
        aborted: w.__uploadAborted__ || "",
        // Audit rows the guard files itself — the `warn` policy's whole output.
        logged: w.__logged__ || [],
      };
    });
    return { ...state, uploadBodies, uploadBuffers };
  } finally {
    await page.close();
  }
}

const gateway = createGatewayServer();
await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
const gatewayBase = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
const { server: statics, base: pageBase } = await startStatic();
const browser = await chromium.launch({ headless: true });

try {
  // ---- HAPPY: token on the wire, one send, turn logged as openai/grok --------
  {
    const r = await sendOneTurn(browser, pageBase, gatewayBase);
    const wire = r.wireBodies.join("\n");
    check("happy: exactly one send reached Grok's conversation endpoint", r.wireBodies.length === 1, String(r.wireBodies.length));
    check("happy: the wire body carries the redacted token", wire.includes(TOKEN), wire.slice(0, 200));
    check("happy: the wire body contains NO raw PII", !wire.includes(PII_EMAIL), wire.slice(0, 200));
    // The token has to be in the `message` field specifically — that is the
    // field Grok builds from the ProseMirror model and the one the tripwire and
    // the acceptance criteria both name.
    let messageField = "";
    try {
      messageField = JSON.parse(r.wireBodies[0] || "{}").message ?? "";
    } catch {
      /* left empty -> the check below fails with the raw body as detail */
    }
    check(
      "happy: the token is in the JSON `message` field the ProseMirror model builds",
      messageField.includes(TOKEN) && !messageField.includes(PII_EMAIL),
      wire.slice(0, 200),
    );
    check(
      "happy: exactly one gateway /redact call (loop guard held on the re-fire)",
      r.gatewayCalls.filter((c) => c === "/redact").length === 1,
      JSON.stringify(r.gatewayCalls),
    );
    const turn = r.logged[0];
    check("happy: the turn is logged", !!turn, JSON.stringify(r.logged));
    check("happy: logged as provider openai", turn?.provider === "openai", turn?.provider);
    check("happy: logged as source grok-web-extension", turn?.source === "grok-web-extension", turn?.source);
    check("happy: the tier button label becomes the log model", turn?.model === "grok-expert", turn?.model);
    // Grok has NO semantic reply selector (responseSelectors is empty), so this
    // reply can only have come from the shape-based capture.
    check(
      "happy: the reply is captured by SHAPE despite no semantic selector",
      (turn?.response || "").includes("the migration plan"),
      JSON.stringify((turn?.response || "").slice(0, 160)),
    );
    check(
      "happy: a suggestion chip after the reply was NOT logged as the answer",
      !(turn?.response || "").includes("Show fewer suggestions"),
      JSON.stringify((turn?.response || "").slice(0, 160)),
    );
    check(
      "happy: the Gemini `div.ql-editor` decoy was NOT used as the composer",
      r.decoyText.trim() === "decoy composer",
      r.decoyText,
    );
  }

  // ---- FAILURE: gateway unreachable -> nothing sent, user told ---------------
  {
    // Port 1 is never a gateway: connection is refused immediately.
    const r = await sendOneTurn(browser, pageBase, "http://127.0.0.1:1", { waitForLog: false });
    check("failure: nothing was sent when the gateway is unreachable", r.wireBodies.length === 0, JSON.stringify(r.wireBodies));
    check(
      "failure: the user was told the send was blocked (fail closed)",
      r.blocked.includes("gateway-unreachable"),
      JSON.stringify(r.blocked),
    );
    check("failure: no raw PII reached the wire", !r.wireBodies.join("").includes(PII_EMAIL));
  }

  // ---- EDGE (a): the UNLABELED submit button is intercepted on click ---------
  // Grok's send control carries no aria-label, no data-testid and no "Send"
  // text, so the generic click filter that covers Gemini and ChatGPT does not
  // match it. If the site's own liveSendSelector were not unioned in, this click
  // would bypass interception and put the RAW prompt on the wire.
  {
    const r = await sendOneTurn(browser, pageBase, gatewayBase, { submit: "click" });
    const wire = r.wireBodies.join("\n");
    check("edge: clicking the unlabeled submit button still sends exactly once", r.wireBodies.length === 1, String(r.wireBodies.length));
    check("edge: the clicked send carries the redacted token", wire.includes(TOKEN), wire.slice(0, 200));
    check("edge: the clicked send contains NO raw PII", !wire.includes(PII_EMAIL), wire.slice(0, 200));
  }

  // ---- EDGE (b): editor model refuses the write -> tripwire aborts, no leak ---
  {
    const r = await sendOneTurn(browser, pageBase, gatewayBase, { stale: true, waitForLog: false });
    const wire = r.wireBodies.join("\n");
    check(
      "edge: a desynced editor model does NOT put raw PII on the wire (tripwire aborted)",
      !wire.includes(PII_EMAIL),
      wire.slice(0, 200),
    );
    check("edge: the page saw the send fail rather than succeed", r.sent.length === 0, JSON.stringify(r.sent).slice(0, 160));
    check(
      "edge: the tripwire reported the block on Grok's endpoint",
      r.blocked.includes("tripwire-fetch"),
      JSON.stringify(r.blocked),
    );
  }

  // ==== FILE UPLOADS (probed live 2026-07-31) =================================
  // The bytes leave 35ms after the ATTACH and ~24s before the message is sent, so
  // these assert on the UPLOAD request and never on the conversation POST. Two
  // things differ from ChatGPT and both are exercised here: the body is multipart
  // FormData rather than a raw File, and it is issued with `fetch` rather than
  // XHR — the wire-level backstop was XHR-only before Grok.
  {
    // happy -----------------------------------------------------------------
    const up = await attachFile(browser, pageBase, gatewayBase, {
      name: "notes.txt",
      mimeType: "text/plain",
      body: `contact: ${PII_EMAIL}\nsecond line stays put`,
    });
    const body = up.uploadBodies.join("\n");
    check("upload happy: exactly one upload request left the page", up.uploadBodies.length === 1, String(up.uploadBodies.length));
    check("upload happy: the multipart body carries the redacted token", body.includes(TOKEN), body.slice(0, 300));
    check("upload happy: the multipart body contains NO raw PII", !body.includes(PII_EMAIL), body.slice(0, 300));
    check("upload happy: non-PII content survives the scrub", body.includes("second line stays put"), body.slice(0, 300));
    // The page must still believe it got the file it asked for, or the attachment
    // chip and the filename it shows the user would be wrong.
    check("upload happy: the page keeps the original filename", up.uploads[0]?.name === "notes.txt", JSON.stringify(up.uploads[0]));
    // Prove it at the source: what the PAGE was handed is already redacted, so
    // there is no window in which a raw copy exists for it to send.
    check(
      "upload happy: the File handed to the page was already redacted",
      (up.uploads[0]?.text || "").includes(TOKEN) && !(up.uploads[0]?.text || "").includes(PII_EMAIL),
      JSON.stringify(up.uploads[0]?.text || "").slice(0, 200),
    );
    check("upload happy: nothing was reported as blocked", up.blocked.length === 0, JSON.stringify(up.blocked));
  }
  {
    // failure: an unscannable format is refused rather than uploaded unscanned --
    const up = await attachFile(browser, pageBase, gatewayBase, {
      name: "payroll.pdf",
      mimeType: "text/plain", // a text MIME must NOT beat a binary extension
      body: `contact: ${PII_EMAIL}`,
    });
    check("upload failure: an unscannable PDF is never uploaded", up.uploadBodies.length === 0, JSON.stringify(up.uploadBodies).slice(0, 200));
    check("upload failure: the user was told why", up.blocked.includes("upload-blocked"), JSON.stringify(up.blocked));
  }
  {
    // failure: gateway down -> the file is not uploaded at all ------------------
    const up = await attachFile(browser, pageBase, "http://127.0.0.1:1", {
      name: "notes.txt",
      mimeType: "text/plain",
      body: `contact: ${PII_EMAIL}`,
    });
    check("upload failure: a dead gateway blocks the upload entirely", up.uploadBodies.length === 0, JSON.stringify(up.uploadBodies).slice(0, 200));
    check(
      "upload failure: the user was told the gateway was unreachable",
      up.blocked.includes("gateway-unreachable"),
      JSON.stringify(up.blocked),
    );
  }
  {
    // edge: a clean file is uploaded byte-for-byte unchanged --------------------
    const clean = "release notes: shipped the migration on Tuesday";
    const up = await attachFile(browser, pageBase, gatewayBase, {
      name: "clean.txt",
      mimeType: "text/plain",
      body: clean,
    });
    check("upload edge: a clean file still uploads", up.uploadBodies.length === 1, String(up.uploadBodies.length));
    check("upload edge: its bytes are unchanged", up.uploadBodies.join("").includes(clean), up.uploadBodies.join("").slice(0, 300));
  }
  {
    // edge: the wire-level backstop catches an upload that bypassed the DOM guard
    // ENTIRELY. This is the case that needed a fetch-side branch: the body is
    // multipart, and Grok posts it with fetch, so before this change nothing
    // inspected it and a bypassed raw upload would have gone out.
    const up = await attachFile(browser, pageBase, gatewayBase, { rawUpload: `contact: ${PII_EMAIL}` });
    check(
      "upload edge: a raw multipart upload that bypassed the guard is aborted",
      up.uploadBodies.length === 0,
      JSON.stringify(up.uploadBodies).slice(0, 200),
    );
    check("upload edge: the tripwire reported the upload block", up.blocked.includes("tripwire-upload"), JSON.stringify(up.blocked));
  }
  {
    // DRAG & DROP. Until now this path had no automated coverage on ANY surface —
    // both harnesses drove the picker only, and it had been exercised live just
    // once (Firefox/ChatGPT). It is not a variation of the picker: the guard has
    // to re-fire a constructed `DragEvent` instead of writing `input.files`, and
    // that event has to reach the page's own handler to be honoured.
    const dropped = `dropped file\ncontact: ${PII_EMAIL}\nthis tail must survive`;
    const up = await attachFile(browser, pageBase, gatewayBase, {
      name: "dropped.txt",
      mimeType: "text/plain",
      body: dropped,
      via: "drop",
    });
    check("drop happy: a dropped file is still uploaded", up.uploadBodies.length === 1, String(up.uploadBodies.length));
    // The original drop being swallowed rather than merely beaten: if it had also
    // reached the page there would be a second, RAW upload alongside ours.
    check("drop happy: the page was handed exactly one file", up.uploads.length === 1, JSON.stringify(up.uploads.map((u: any) => u.name)));
    const body = up.uploadBodies.join("");
    check("drop happy: the dropped file's body carries the redacted token", body.includes(TOKEN), body.slice(0, 300));
    check("drop happy: the dropped file's body contains NO raw PII", !body.includes(PII_EMAIL), body.slice(0, 300));
    check("drop happy: non-PII content survives the drop scrub", body.includes("this tail must survive"), body.slice(0, 300));
    check("drop happy: the page keeps the dropped filename", up.uploads[0]?.name === "dropped.txt", JSON.stringify(up.uploads[0]));
    // The strongest of these: the page is handed an already-clean File, so no raw
    // copy exists for it to upload even if it re-reads the DataTransfer later.
    check(
      "drop happy: the File the page received from the re-drop was already redacted",
      (up.uploads[0]?.text || "").includes(TOKEN) && !(up.uploads[0]?.text || "").includes(PII_EMAIL),
      JSON.stringify(up.uploads[0]?.text || "").slice(0, 200),
    );
  }
  {
    // drop failure: the format block applies to a drop too. Worth its own case —
    // a guard that only refused picker attachments would leave the drop zone as a
    // wide-open hole for exactly the files it is meant to stop.
    const up = await attachFile(browser, pageBase, gatewayBase, {
      name: "payroll.pdf",
      mimeType: "text/plain", // a lying MIME type: the extension must still win
      body: `%PDF-1.4 salary for ${PII_EMAIL}`,
      via: "drop",
    });
    check("drop failure: an unscannable dropped PDF is never uploaded", up.uploadBodies.length === 0, JSON.stringify(up.uploadBodies).slice(0, 200));
    check("drop failure: the page was never handed the dropped PDF at all", up.uploads.length === 0, JSON.stringify(up.uploads).slice(0, 200));
    check("drop failure: the user was told why the drop was refused", up.blocked.includes("upload-blocked"), JSON.stringify(up.blocked));
  }
  {
    // MIXED MULTI-FILE ATTACH: a .txt and a .docx in one go. Verified live on
    // grok.com 2026-07-31, and it exercises a combination no single-file case can:
    // the two kinds take DIFFERENT branches in the guard's reassembly — an Office
    // scrub returns a whole rebuilt File (`decision.file`), a text scrub returns
    // replacement TEXT that has to be wrapped back into a File. Both fire in one
    // pass here, so a mix-up would put the docx's bytes under the .txt's name or
    // wrap the archive as text and corrupt it.
    const txt = `notes\ncontact: ${PII_EMAIL}\nkeep this tail`;
    const up = await attachFile(browser, pageBase, gatewayBase, {
      files: [
        { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(txt, "utf8") },
        { name: "brief.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await docxBytes() },
      ],
    });
    check("multi happy: both files were uploaded", up.uploadBodies.length === 2, String(up.uploadBodies.length));
    check(
      "multi happy: the order and filenames are preserved",
      up.uploads.map((u: any) => u.name).join(",") === "notes.txt,brief.docx",
      JSON.stringify(up.uploads.map((u: any) => u.name)),
    );
    const all = up.uploadBodies.join("");
    check("multi happy: no raw PII in either upload", !all.includes(PII_EMAIL), all.slice(0, 200));
    check("multi happy: the text file was tokenised", all.includes(TOKEN), all.slice(0, 300));
    check("multi happy: the text file's non-PII tail survived", all.includes("keep this tail"), all.slice(0, 300));
    // The docx must still be a ZIP — proof the Office branch handed back a rebuilt
    // archive rather than the text branch stringifying it.
    const docx = up.uploads.find((u: any) => u.name === "brief.docx");
    check("multi happy: the docx is still a zip archive, not text-wrapped", (docx?.text || "").includes("PK"), (docx?.text || "").slice(0, 40));
    // Read the UPLOADED archive back rather than grepping its compressed bytes,
    // which would assert nothing about the XML actually inside it.
    const docxBody = up.uploadBuffers.find((b: Buffer) => b.includes(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
    const xml = docxBody ? await docxTextFromMultipart(docxBody) : "";
    check("multi happy: the uploaded docx still unzips", xml.startsWith("<?xml"), xml.slice(0, 60));
    check("multi happy: the docx's split-across-runs PII was redacted in the XML", xml.includes(TOKEN) && !xml.includes(PII_EMAIL), xml.slice(0, 300));
    check(
      "multi happy: the docx's clean paragraph came back untouched",
      xml.includes("no sensitive data and must come back untouched"),
      xml.slice(0, 300),
    );
  }
  {
    // multi failure: ALL-OR-NOTHING. One unscannable file in the batch must stop
    // the whole attach — quietly dropping it and uploading the rest is a partial
    // success the user would not notice, and they would believe the PDF was sent.
    const up = await attachFile(browser, pageBase, gatewayBase, {
      files: [
        { name: "clean.txt", mimeType: "text/plain", buffer: Buffer.from("nothing sensitive here", "utf8") },
        { name: "payroll.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 binary", "utf8") },
      ],
    });
    check("multi failure: one unscannable file blocks the WHOLE attach", up.uploadBodies.length === 0, JSON.stringify(up.uploadBodies).slice(0, 200));
    check("multi failure: not even the clean sibling was uploaded", up.uploads.length === 0, JSON.stringify(up.uploads).slice(0, 200));
    check("multi failure: the user was told why", up.blocked.includes("upload-blocked"), JSON.stringify(up.blocked));
  }
  {
    // uploadPolicy:"warn" — THE ESCAPE HATCH, for people who must attach real work
    // PDFs. Until now it had no coverage at all, and its config key turned out not
    // even to reach MAIN world, so the behavior behind it was entirely unproven.
    const up = await attachFile(browser, pageBase, gatewayBase, {
      name: "payroll.pdf",
      mimeType: "application/pdf",
      body: "%PDF-1.4 binary-ish contents",
      uploadPolicy: "warn",
    });
    check("warn happy: a PDF that `block` would refuse is uploaded under warn", up.uploadBodies.length === 1, String(up.uploadBodies.length));
    check("warn happy: the user is NOT told it was blocked", up.blocked.length === 0, JSON.stringify(up.blocked));
    // The point of the policy: it trades a refusal for an AUDIT ROW, so a missing
    // row would mean the file left with no trace — strictly worse than blocking.
    const row = up.logged.find((t: any) => t.unchecked === true);
    check("warn happy: an `unchecked` audit row is filed", !!row, JSON.stringify(up.logged).slice(0, 300));
    check("warn happy: the row names the file so the audit is actionable", (row?.prompt || "").includes("payroll.pdf"), row?.prompt);
    check("warn happy: the row is attributed to the surface", row?.provider === "openai" && row?.source === "grok-web-extension", JSON.stringify(row));
    // Metadata only — we could not read the contents, and must not pretend to.
    check("warn happy: the row carries no file CONTENT", !(row?.prompt || "").includes("binary-ish"), row?.prompt);
  }
  {
    // warn edge: the hatch is SCOPED. A gateway failure is our inability to verify
    // a file we CAN read, not a limit of the format, so it must still block even
    // under warn — otherwise "warn" would quietly become "send everything raw
    // whenever the gateway hiccups", which is the opposite of the intent.
    const up = await attachFile(browser, pageBase, "http://127.0.0.1:1", {
      name: "notes.txt",
      mimeType: "text/plain",
      body: `contact: ${PII_EMAIL}`,
      uploadPolicy: "warn",
    });
    check("warn edge: a readable file still BLOCKS under warn when the gateway is down", up.uploadBodies.length === 0, JSON.stringify(up.uploadBodies).slice(0, 200));
    check("warn edge: and no raw PII reached the wire", !up.uploadBodies.join("").includes(PII_EMAIL));
    check(
      "warn edge: the user is told the gateway was unreachable",
      up.blocked.includes("gateway-unreachable") || up.blocked.includes("upload-blocked"),
      JSON.stringify(up.blocked),
    );
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => statics.close(() => r()));
  await new Promise<void>((r) => gateway.close(() => r()));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
