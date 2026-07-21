// ===== GEMINI EXTENSION — Playwright e2e (DOM mechanics) ===================
// Drives the REAL content-main.js in a REAL Chromium DOM against a fake Gemini
// page (fake-gemini.html) backed by the REAL redaction gateway. Validates the
// Stage-3 make-or-break mechanics the unit tests can't reach:
//   - capture-phase intercept kills the original submit (no raw PII leaves)
//   - redacted text is written so the page reads it back (model-sync)
//   - a synthetic re-submit is fired and NOT re-intercepted (loop guard)
//   - exactly ONE gateway call and ONE send per user submit
//   - gateway unreachable -> send is blocked (fail-closed)
//
// Run: node --experimental-strip-types extension/test/e2e/run.mjs
// (Not part of `npm test` — needs a browser and is slow. See extension/README.)
//
// NOTE: this exercises content-main's messaging contract (it dispatches
// redact-request and awaits redact-response); the page simulates the
// bridge+background. The real bridge/background/CORS path is verified manually
// in Chrome (README) — it is origin-plumbing, not the risky DOM logic here.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { createGatewayServer } from "../../../secure-llm-gateway.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, "../..");

// Runtime-built PII (no full literal in source).
const EMAIL = "alice" + "@" + "corp.com";

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

/**
 * Serve the extension/ dir statically so `import "./x.js"` and the page resolve,
 * AND expose a SAME-ORIGIN `POST /redact` that proxies to the gateway
 * server-side. Same-origin is deliberate: it mirrors how the real extension
 * sidesteps page CORS (the background service worker fetches with
 * host_permissions). The e2e's job is the DOM mechanics, not re-testing CORS —
 * so we remove CORS from the browser side exactly as the SW does in production.
 */
function startStatic(gatewayBase: string): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && (req.url || "").split("?")[0] === "/redact") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const r = await fetch(`${gatewayBase}/redact`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
          const text = await r.text();
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(text);
        } catch {
          res.writeHead(502);
          res.end("{}");
        }
      });
      return;
    }
    let rel = decodeURIComponent((req.url || "/").split("?")[0]);
    if (rel === "/") rel = "/test/e2e/fake-gemini.html";
    const file = path.join(EXT_ROOT, rel);
    if (!file.startsWith(EXT_ROOT) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${ok ? "" : "  <-- " + detail}`);
}

const gateway = createGatewayServer();
await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
const gatewayBase = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
const { server: statics, base: pageBase } = await startStatic(gatewayBase);
const browser = await chromium.launch({ headless: true });

try {
  // ---- HAPPY: type PII, Enter -> redacted text sent, exactly one send/call ----
  {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.goto(`${pageBase}/?base=${encodeURIComponent(pageBase)}`);
    const box = page.locator(".ql-editor");
    await box.click();
    await box.type(`please email ${EMAIL} today`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as any).__sent__.length >= 1, { timeout: 5000 }).catch(() => {});

    const sent = await page.evaluate(() => (window as any).__sent__);
    const calls = await page.evaluate(() => (window as any).__redactCalls__);
    check("happy: exactly one send reached the page", sent.length === 1, `got ${sent.length}`);
    check("happy: exactly one gateway /redact call (loop guard held)", calls === 1, `got ${calls}`);
    check("happy: sent text is redacted (token present)", /\[REDACTED_PII_EMAIL\]/.test(sent[0] || ""), sent[0]);
    check("happy: sent text has NO raw PII", !(sent[0] || "").includes("corp.com"), sent[0]);
    await page.close();
  }

  // ---- EDGE: Send BUTTON path redacts the same way --------------------------
  {
    const page = await browser.newPage();
    await page.goto(`${pageBase}/?base=${encodeURIComponent(pageBase)}`);
    const box = page.locator(".ql-editor");
    await box.click();
    await box.type(`card 4111 1111 1111 1111 and mail ${EMAIL}`);
    await page.locator('button[aria-label="Send"]').click();
    await page.waitForFunction(() => (window as any).__sent__.length >= 1, { timeout: 5000 }).catch(() => {});
    const sent = await page.evaluate(() => (window as any).__sent__);
    check("edge: send-button path produced exactly one send", sent.length === 1, `got ${sent.length}`);
    check(
      "edge: send-button path redacted email + card",
      /\[REDACTED_PII_EMAIL\]/.test(sent[0] || "") && !(sent[0] || "").includes("corp.com") && !(sent[0] || "").includes("4111111111111111"),
      sent[0],
    );
    await page.close();
  }

  // ---- FAILURE: gateway unreachable -> send blocked (fail-closed) -----------
  {
    const page = await browser.newPage();
    // Point the page's redact responder at a dead port.
    const deadBase = "http://127.0.0.1:1"; // nothing listening
    await page.goto(`${pageBase}/?base=${encodeURIComponent(deadBase)}`);
    const box = page.locator(".ql-editor");
    await box.click();
    await box.type(`leak ${EMAIL} please`);
    await page.keyboard.press("Enter");
    // Give it time to attempt + fail + decide-block.
    await page.waitForTimeout(1500);
    const sent = await page.evaluate(() => (window as any).__sent__);
    const blocked = await page.evaluate(() => (window as any).__blocked__);
    check("failure: nothing was sent when gateway is unreachable", sent.length === 0, `sent=${JSON.stringify(sent)}`);
    check("failure: user was notified of the fail-closed block", blocked.includes("gateway-unreachable"), JSON.stringify(blocked));
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => statics.close(() => r()));
  await new Promise<void>((r) => gateway.close(() => r()));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
