// ===== CHATGPT SURFACE — Playwright e2e (send path + reply capture) =========
// Drives the REAL content-main.js / composer.js / site-adapter.js / tripwire.js
// in real Chromium against fake-chatgpt.html (which reproduces ChatGPT's
// ProseMirror composer, its hidden companion textarea, the send/stop buttons and
// the `data-message-author-role` reply markup) backed by the REAL gateway.
//
//   HAPPY    a prompt containing PII leaves as a redacted TOKEN on the
//            /backend-api/conversation wire, with zero raw PII, exactly ONE send
//            and exactly ONE gateway call, and the turn is logged as
//            provider "openai" / source "chatgpt-web-extension" with the reply.
//   FAILURE  the gateway is unreachable -> NOTHING is sent (fail closed) and the
//            user is told.
//   EDGE     an editor whose model refuses programmatic edits (the ProseMirror
//            desync the probe ruled out) -> the DOM path cannot redact, so the G4
//            tripwire ABORTS the request: still no raw PII on the wire.
//
// The PII value is assembled at runtime so no PII literal lives in this file.
//
// Run: npm run test:chatgpt-e2e   (needs `npx playwright install chromium`)

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
// ChatGPT's message POST. The fixture posts to this path on the page's own
// origin, so the tripwire's endpoint scoping is exercised for real.
const CONVERSATION_PATH = "/backend-api/conversation";

/**
 * Serve the extension tree (so the page can import the real modules) and answer
 * the fake conversation endpoint.
 */
function startStatic(): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === CONVERSATION_PATH) {
      // Drain the body so the request completes like the real endpoint would.
      req.resume();
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    const rel = url.pathname === "/" ? "/test/e2e/fake-chatgpt.html" : url.pathname;
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
 * Open the fake page, type PROMPT with real keystrokes, submit with Enter, and
 * report what crossed the wire plus what the extension logged.
 *
 * `gatewayBase` is pointed at a dead port for the fail-closed case. `stale`
 * selects the editor that refuses programmatic edits.
 */
async function sendOneTurn(
  browser: Browser,
  pageBase: string,
  gatewayBase: string,
  opts: { stale?: boolean; waitForLog?: boolean } = {},
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
    // `site` forces the ChatGPT adapter: the fixture is served from 127.0.0.1, so
    // the hostname cannot select it the way chatgpt.com does in production.
    await page.evaluate(
      (cfg) => window.dispatchEvent(new CustomEvent("gemini-redact:config", { detail: cfg })),
      { site: "chatgpt", settleMs: 500, turnTimeoutMs: 12000, tripwire: true, base: gatewayBase },
    );
    const box = page.locator("#prompt-textarea");
    await box.click();
    await box.type(PROMPT, { delay: 5 });
    await page.keyboard.press("Enter");
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
        composerText: (document.getElementById("prompt-textarea") as HTMLElement).innerText,
        mirrorValue: (document.querySelector("textarea[name='prompt-textarea']") as HTMLTextAreaElement).value,
        decoyText: (document.getElementById("decoy") as HTMLElement).innerText,
      };
    });
    return { ...state, wireBodies, gatewayCalls };
  } finally {
    await page.close();
  }
}

/** A minimal but structurally real .docx, built with the extension's own zip writer. */
async function makeDocx(paragraphs: string[][]) {
  const enc = (s: string) => new TextEncoder().encode(s);
  const body = paragraphs
    .map((runs) => `<w:p>${runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join("")}</w:p>`)
    .join("");
  return writeZip([
    { name: "[Content_Types].xml", data: enc(`<?xml version="1.0"?><Types/>`) },
    { name: "_rels/.rels", data: enc(`<?xml version="1.0"?><Relationships/>`) },
    {
      name: "word/document.xml",
      data: enc(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
      ),
    },
  ]);
}

/**
 * Attach a file (or trigger a raw bypass upload) and report what reached the wire.
 *
 * The upload host is intercepted rather than reached: the fixture PUTs to a real
 * `*.oaiusercontent.com` URL so `isUploadUrl`'s domain-SUFFIX match is exercised
 * for real (the live host is region-specific and must never be hard-coded), while
 * Playwright fulfils it locally so no external request is made.
 */
async function attachFile(
  browser: Browser,
  pageBase: string,
  gatewayBase: string,
  opts: { name?: string; mimeType?: string; body?: string; buffer?: Uint8Array; rawUpload?: string },
) {
  const page: Page = await browser.newPage();
  const uploadBodies: string[] = [];
  const uploadBuffers: Buffer[] = [];
  await page.route("**://*.oaiusercontent.com/**", async (route) => {
    // postDataBuffer, not postData: the body is a File/Blob, and for an Office
    // file it is binary — the string form is only used by the text assertions.
    const buf = route.request().postDataBuffer() ?? Buffer.alloc(0);
    uploadBuffers.push(buf);
    uploadBodies.push(buf.toString("utf8"));
    await route.fulfill({ status: 200, body: "{}" , contentType: "application/json" });
  });
  try {
    await page.goto(`${pageBase}/?${new URLSearchParams({ base: gatewayBase })}`);
    await page.evaluate(
      (cfg) => window.dispatchEvent(new CustomEvent("gemini-redact:config", { detail: cfg })),
      { site: "chatgpt", settleMs: 500, turnTimeoutMs: 12000, tripwire: true, base: gatewayBase },
    );

    if (opts.rawUpload !== undefined) {
      await page.evaluate((t) => (window as any).__rawUpload__(t), opts.rawUpload);
    } else {
      await page.setInputFiles("#file-input", {
        name: opts.name!,
        mimeType: opts.mimeType!,
        buffer: opts.buffer ? Buffer.from(opts.buffer) : Buffer.from(opts.body!, "utf8"),
      });
    }
    // The guard kills the original event and re-fires after a gateway round trip,
    // and the tripwire backstop defers send() across an async Blob read.
    await page.waitForTimeout(2500);

    const state = await page.evaluate(() => {
      const w = window as any;
      return { uploads: w.__uploads__ || [], blocked: w.__blocked__ || [], aborted: w.__uploadAborted__ || "" };
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
  // ---- HAPPY: token on the wire, one send, turn logged as openai/chatgpt -----
  {
    const r = await sendOneTurn(browser, pageBase, gatewayBase);
    const wire = r.wireBodies.join("\n");
    check("happy: exactly one send reached ChatGPT's conversation endpoint", r.wireBodies.length === 1, String(r.wireBodies.length));
    check("happy: the wire body carries the redacted token", wire.includes(TOKEN), wire.slice(0, 200));
    check("happy: the wire body contains NO raw PII", !wire.includes(PII_EMAIL), wire.slice(0, 200));
    check(
      "happy: exactly one gateway /redact call (loop guard held on the re-fire)",
      r.gatewayCalls.filter((c) => c === "/redact").length === 1,
      JSON.stringify(r.gatewayCalls),
    );
    const turn = r.logged[0];
    check("happy: the turn is logged", !!turn, JSON.stringify(r.logged));
    check("happy: logged as provider openai", turn?.provider === "openai", turn?.provider);
    check("happy: logged as source chatgpt-web-extension", turn?.source === "chatgpt-web-extension", turn?.source);
    check("happy: the model switcher label becomes the log model", turn?.model === "chatgpt-5-thinking", turn?.model);
    check(
      "happy: the assistant reply is captured for the log",
      (turn?.response || "").includes("here is the summary you asked for"),
      JSON.stringify((turn?.response || "").slice(0, 120)),
    );
    // The write must land in the ProseMirror composer, never in the companion
    // textarea (which the real page ignores) and never in the Gemini decoy.
    check(
      "edge: the Gemini `div.ql-editor` decoy was NOT used as the composer",
      r.decoyText.trim() === "decoy composer",
      r.decoyText,
    );
    check(
      "edge: the hidden companion textarea was not treated as the composer",
      r.mirrorValue === "",
      r.mirrorValue,
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

  // ---- EDGE: editor model refuses the write -> tripwire aborts, no leak ------
  {
    const r = await sendOneTurn(browser, pageBase, gatewayBase, { stale: true, waitForLog: false });
    const wire = r.wireBodies.join("\n");
    check(
      "edge: a desynced editor model does NOT put raw PII on the wire (tripwire aborted)",
      !wire.includes(PII_EMAIL),
      wire.slice(0, 200),
    );
    check(
      "edge: the page saw the send fail rather than succeed",
      r.sent.length === 0,
      JSON.stringify(r.sent).slice(0, 160),
    );
    check(
      "edge: the tripwire reported the block on ChatGPT's endpoint",
      r.blocked.includes("tripwire-fetch"),
      JSON.stringify(r.blocked),
    );
  }

  // ==== PHASE Q — FILE UPLOADS ==============================================
  // Probed live 2026-07-30: the File is XHR-PUT to a region-specific
  // oaiusercontent.com host at ATTACH time, ~19s BEFORE the message is sent. So
  // these tests assert on the UPLOAD request, not the conversation POST.
  {
    // happy -----------------------------------------------------------------
    const up = await attachFile(browser, pageBase, gatewayBase, {
      name: "notes.txt",
      mimeType: "text/plain",
      body: `contact ${PII_EMAIL} about the invoice`,
    });
    const body = up.uploadBodies.join("\n");
    check("upload happy: exactly one upload request was made", up.uploadBodies.length === 1, String(up.uploadBodies.length));
    check("upload happy: the uploaded bytes carry the token", body.includes(TOKEN), body.slice(0, 200));
    check("upload happy: the uploaded bytes contain NO raw PII", !body.includes(PII_EMAIL), body.slice(0, 200));
    check(
      "upload happy: the page was handed exactly one file, under its original name",
      up.uploads.length === 1 && up.uploads[0]?.name === "notes.txt",
      JSON.stringify(up.uploads),
    );
    check("upload happy: nothing was reported as blocked", up.blocked.length === 0, JSON.stringify(up.blocked));

    // failure ---------------------------------------------------------------
    // A PDF cannot be parsed without a dependency, so it must be refused rather
    // than uploaded unscanned. `%PDF-` bytes with a PII string inside prove the
    // decision is made on the FORMAT, not on whether a scan happened to match.
    const pdf = await attachFile(browser, pageBase, gatewayBase, {
      name: "payroll.pdf",
      mimeType: "application/pdf",
      body: `%PDF-1.4 ${PII_EMAIL}`,
    });
    check("upload failure: an unscannable PDF is never uploaded", pdf.uploadBodies.length === 0, JSON.stringify(pdf.uploadBodies));
    check("upload failure: the page never received the file", pdf.uploads.length === 0, JSON.stringify(pdf.uploads));
    check("upload failure: the user was told why", pdf.blocked.includes("upload-blocked"), JSON.stringify(pdf.blocked));

    // A scannable file with the gateway down must also fail closed.
    const dead = await attachFile(browser, pageBase, "http://127.0.0.1:1", {
      name: "notes.txt",
      mimeType: "text/plain",
      body: `contact ${PII_EMAIL}`,
    });
    check("upload failure: gateway down blocks the upload", dead.uploadBodies.length === 0, JSON.stringify(dead.uploadBodies));
    check(
      "upload failure: gateway down is reported as gateway-unreachable",
      dead.blocked.includes("gateway-unreachable"),
      JSON.stringify(dead.blocked),
    );

    // edge ------------------------------------------------------------------
    // A clean file must pass through UNTOUCHED — a guard that rewrites or blocks
    // every attachment would be abandoned by users, and re-wrapping a clean file
    // is a behavior change for no security gain.
    const cleanBody = "just some notes, nothing sensitive";
    const clean = await attachFile(browser, pageBase, gatewayBase, {
      name: "clean.txt",
      mimeType: "text/plain",
      body: cleanBody,
    });
    check("upload edge: a clean file still uploads", clean.uploadBodies.length === 1, JSON.stringify(clean.uploadBodies));
    check(
      "upload edge: a clean file's bytes are unchanged",
      clean.uploadBodies[0] === cleanBody,
      JSON.stringify(clean.uploadBodies[0] || "").slice(0, 120),
    );

    // The BACKSTOP: if the DOM guard is bypassed entirely, the tripwire must
    // abort a raw-PII upload on the wire. This is the async Blob-read path, which
    // defers send() — the one change made to the security-critical wrapper.
    const bypass = await attachFile(browser, pageBase, gatewayBase, {
      rawUpload: `contact ${PII_EMAIL} directly`,
    });
    check(
      "upload edge: the tripwire aborts a raw-PII upload that bypassed the DOM guard",
      bypass.uploadBodies.length === 0,
      JSON.stringify(bypass.uploadBodies),
    );
    check(
      "upload edge: the tripwire reported the upload block",
      bypass.blocked.includes("tripwire-upload"),
      JSON.stringify(bypass.blocked),
    );

    // ---- Phase R: Office files are scrubbed, not refused --------------------
    // The address is SPLIT ACROSS RUNS, as Word actually stores it — scanning
    // runs individually would find nothing and upload the document raw.
    const docx = await makeDocx([
      ["Payroll contact: ", "casey.tester@", "example", ".com today"],
      ["No sensitive data on this line"],
    ]);
    const office = await attachFile(browser, pageBase, gatewayBase, {
      name: "payroll.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: docx,
    });
    check("upload office: the document was uploaded, not refused", office.uploadBuffers.length === 1, JSON.stringify(office.blocked));
    if (office.uploadBuffers.length === 1) {
      const entries = await readZip(new Uint8Array(office.uploadBuffers[0]));
      const doc = entries.find((e) => e.name === "word/document.xml");
      const xml = doc ? new TextDecoder().decode(doc.data) : "";
      check("upload office: the uploaded file is still a valid archive", !!doc, entries.map((e) => e.name).join(","));
      check("upload office: PII split across runs was caught and tokenised", xml.includes(TOKEN), xml.slice(0, 300));
      check("upload office: no raw PII survives in the document", !xml.includes(PII_EMAIL), xml.slice(0, 300));
      check(
        "upload office: the untouched paragraph is left exactly as it was",
        xml.includes("No sensitive data on this line"),
        xml.slice(0, 300),
      );
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => statics.close(() => r()));
  await new Promise<void>((r) => gateway.close(() => r()));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
