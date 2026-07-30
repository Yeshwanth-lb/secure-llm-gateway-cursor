// ===== GEMINI EXTENSION — Playwright e2e (assistant-response capture) =======
// Sibling of run.mts (which covers the SEND path). This harness drives the REAL
// content-main.js + response-capture.js in a REAL Chromium DOM against
// fake-panel.html, which reproduces the three Gemini panel DOMs Google ships
// (WORKSPACE_COVERAGE §5.6), and asserts what the extension would POST to
// /log-turn:
//
//   HAPPY   obfuscated Gmail/Drive-shaped panel (rotating class names) -> the
//           streamed reply is captured, NOT a suggestion chip. This is the case
//           that used to log "(none)".
//   FAILURE only suggestion chips arrive (no reply) -> the turn logs a BLANK
//           response. Logging a chip as the assistant output is the bug that got
//           an earlier class-name-free fallback reverted.
//   EDGE    the semantic appsElements panel (Docs/Sheets/Slides) still resolves
//           through RESPONSE_SELECTORS — the surfaces that already worked must
//           not change.
//
// PII-free by design: this harness is about capture, so the gateway echoes clean
// text and there is no raw PII in the fixture.
//
// Run: npm run test:gemini-response-e2e

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { chromium, type Page } from "playwright";
import { createGatewayServer } from "../../../secure-llm-gateway.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, "../..");
const PROMPT = "summarize the thread and list the owners";
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

/** Serve the extension source tree so the page can import the real modules. */
function startStatic(): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const rel = url.pathname === "/" ? "/test/e2e/fake-panel.html" : url.pathname;
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

type Turn = { prompt: string; response: string; model: string };

const gateway = createGatewayServer();
await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
const gatewayBase = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
const { server: statics, base: pageBase } = await startStatic();
const browser = await chromium.launch({ headless: true });

/**
 * Open a panel in `dom` mode, send one prompt, and return the turn the
 * extension logged. `turnTimeoutMs` is shortened so the "no reply ever arrives"
 * case doesn't sit on the production 30s cap.
 */
async function sendOneTurn(dom: string, timeouts: { settleMs: number; turnTimeoutMs: number }): Promise<Turn | null> {
  const page: Page = await browser.newPage();
  try {
    await page.goto(`${pageBase}/?dom=${dom}&base=${encodeURIComponent(gatewayBase)}`);
    await page.evaluate(
      (cfg) => window.dispatchEvent(new CustomEvent("gemini-redact:config", { detail: cfg })),
      { ...timeouts, tripwire: false },
    );
    const box = page.locator("#composer");
    await box.click();
    await box.type(PROMPT);
    await page.keyboard.press("Enter");
    await page
      .waitForFunction(() => (window as unknown as { __logged__: Turn[] }).__logged__.length > 0, null, {
        timeout: timeouts.turnTimeoutMs + 8000,
      })
      .catch(() => {});
    const logged = await page.evaluate(() => (window as unknown as { __logged__: Turn[] }).__logged__);
    return logged[0] ?? null;
  } finally {
    await page.close();
  }
}

try {
  // ---- HAPPY: obfuscated panel (Gmail/Drive) -> the streamed reply is logged --
  {
    const turn = await sendOneTurn("obfuscated", { settleMs: 600, turnTimeoutMs: 12000 });
    check("obfuscated panel: a turn is logged at all", !!turn, JSON.stringify(turn));
    const response = turn?.response ?? "";
    check(
      "obfuscated panel: the streamed reply is captured (rotating class names, no selector)",
      response.includes("summary of the thread") && response.includes("who owns each of them"),
      JSON.stringify(response.slice(0, 120)),
    );
    check(
      "obfuscated panel: a suggestion chip is NOT logged as the assistant output",
      !/unread emails|fewer suggestions/i.test(response),
      JSON.stringify(response.slice(0, 120)),
    );
    check(
      "obfuscated panel: the user's own prompt is not echoed back as the reply",
      !response.includes(PROMPT),
      JSON.stringify(response.slice(0, 120)),
    );
  }

  // ---- FAILURE: only chips arrive -> blank response, never a guess ------------
  {
    const turn = await sendOneTurn("chips", { settleMs: 600, turnTimeoutMs: 4000 });
    check("chips-only panel: the turn is still logged (prompt-only)", !!turn, JSON.stringify(turn));
    check(
      "chips-only panel: response is BLANK rather than a suggestion chip",
      (turn?.response ?? "x") === "",
      JSON.stringify(turn?.response),
    );
  }

  // ---- EDGE: semantic appsElements panel still uses RESPONSE_SELECTORS -------
  {
    const turn = await sendOneTurn("semantic", { settleMs: 600, turnTimeoutMs: 12000 });
    const response = turn?.response ?? "";
    check(
      "semantic panel (Docs/Sheets/Slides shape): reply still captured via selectors",
      response.includes("summary of the thread"),
      JSON.stringify(response.slice(0, 120)),
    );
    check(
      "semantic panel: prompt is reported for the log (redaction happens gateway-side)",
      (turn?.prompt ?? "") === PROMPT,
      JSON.stringify(turn?.prompt),
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
