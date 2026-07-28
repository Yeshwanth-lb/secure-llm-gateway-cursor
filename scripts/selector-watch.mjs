#!/usr/bin/env node
// ===== LAYER 2 — live selector watcher =====================================
// Early-warning canary for a Gemini/Workspace DOM change. Opens the REAL Google
// surfaces in a pre-logged-in Chrome profile and reports whether the extension
// could still locate the prompt composer. If it can't on any surface, exits
// non-zero so a cron/launchd job turns that into an alert BEFORE users hit
// blocked sends. This does NOT patch anything (Layer 3 is deliberately out of
// scope — see the plan) — it only detects and reports.
//
// It complements the in-page defenses: Layer 1 (composer-finder.js) makes
// findComposer survive most changes; the G4 tripwire keeps a break fail-closed.
// This watcher tells a human when to look.
//
//   Read-only probe (no data sent to Google), live:
//     WATCH_PROFILE_DIR=~/.secure-llm-gateway/watch-profile node scripts/selector-watch.mjs
//   Deep check (types a PII probe + sends + asserts the wire is tokenized):
//     WATCH_SEND=1 WATCH_PROFILE_DIR=... node scripts/selector-watch.mjs
//   Self-test the probe logic headlessly (no Google login needed):
//     node scripts/selector-watch.mjs --self-check
//
// Setup for live mode: launch Chrome once against the profile dir and log into
// Google, e.g.
//   npx playwright ... or just run this script once and log in when the window
//   opens; cookies persist in WATCH_PROFILE_DIR for later headful/headless runs.
//
// Design ref: plan "Layer 2"; advances CLAUDE.md ledger G5 (health check).

import { chromium } from "playwright";
import { shouldInspectUrl } from "../extension/src/tripwire.js";
import http from "node:http";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, "../extension");
const REPORT_PATH = path.join(os.homedir(), ".secure-llm-gateway", "selector-watch-report.json");

const SELF_CHECK = process.argv.includes("--self-check");
const WATCH_SEND = process.env.WATCH_SEND === "1";
// Hold the browser open before probing so you can log into Google and/or open
// each Workspace "Ask Gemini" side panel, then press Enter to run the probes.
const HOLD = process.env.WATCH_HOLD === "1" || process.argv.includes("--hold");
const PROFILE_DIR = (process.env.WATCH_PROFILE_DIR || path.join(os.homedir(), ".secure-llm-gateway", "watch-profile")).replace(
  /^~(?=$|\/)/,
  os.homedir(),
);

// Surfaces to probe live. gemini.google.com always renders a composer; the
// Workspace side panels only render one once the "Ask Gemini" panel is OPEN, so
// they are best-effort (a not-found there may mean "panel closed", not "Google
// changed"). Override with WATCH_SURFACES=comma,separated,urls.
const DEFAULT_SURFACES = [
  { name: "gemini", url: "https://gemini.google.com/app", requiresPanel: false },
  { name: "docs", url: "https://docs.google.com/document/u/0/", requiresPanel: true },
  { name: "gmail", url: "https://mail.google.com/mail/u/0/", requiresPanel: true },
];
const SURFACES = process.env.WATCH_SURFACES
  ? process.env.WATCH_SURFACES.split(",").map((u, i) => ({ name: `surface${i}`, url: u.trim(), requiresPanel: true }))
  : DEFAULT_SURFACES;

/**
 * Runs INSIDE the page (serialized by Playwright — must be self-contained, no
 * imports). A compact mirror of composer.js's findComposer (fast-path selectors
 * + Layer-1 heuristic) — enough to answer "can the extension find the composer
 * here?". Kept in sync with composer.js / composer-finder.js by hand; it is a
 * canary, not the shipped path.
 */
function PROBE() {
  const MIN_AREA = 600;
  const PROMPT = /ask gemini|ask|message|prompt|reply|talk to gemini|type/i;
  const SEARCH = /search|find|filter/i;
  const SELECTORS = [
    'div.ql-editor[contenteditable="true"]',
    "rich-textarea .ql-editor",
    'div[contenteditable="true"][aria-label*="Ask Gemini" i]',
    'div[contenteditable="true"][role="textbox"]',
    "textarea[aria-label]",
  ];
  const vis = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  const sane = (el) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    const r = el.getBoundingClientRect();
    return vis(el) && r.width * r.height >= MIN_AREA;
  };
  const findSend = () =>
    document.querySelector("button.send-button") ||
    document.querySelector('button[aria-label*="Send" i]') ||
    document.querySelector('button[aria-label*="Submit" i]') ||
    document.querySelector("button:has(mat-icon)") ||
    null;

  let composer = null;
  let via = null;
  for (const s of SELECTORS) {
    let el;
    try {
      el = document.querySelector(s);
    } catch {
      continue;
    }
    if (el && sane(el)) {
      composer = el;
      via = "selector:" + s;
      break;
    }
  }
  if (!composer) {
    const cands = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]'));
    let best = -Infinity;
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      const tag = (el.tagName || "").toLowerCase();
      const editable = tag === "textarea" || el.getAttribute("contenteditable") === "true" || el.getAttribute("role") === "textbox";
      const area = r.width * r.height;
      if (!editable || !vis(el) || area < MIN_AREA) continue;
      const label = (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("placeholder") || "");
      let score = 10;
      if (PROMPT.test(label)) score += 40;
      if (SEARCH.test(label)) score -= 30;
      score += Math.min(20, Math.log2(area / MIN_AREA) * 4);
      score += tag === "textarea" ? 6 : 3;
      if (score > best) {
        best = score;
        composer = el;
        via = "heuristic";
      }
    }
  }
  return {
    composerFound: !!composer,
    via,
    composerLabel: composer ? (composer.getAttribute("aria-label") || "").slice(0, 60) : null,
    sendFound: !!findSend(),
  };
}

// --- self-check: run the probe against the local fake pages (no login) -------
function startStatic() {
  const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
  const server = http.createServer((req, res) => {
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
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

async function selfCheck() {
  const { server, base } = await startStatic();
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const [label, qs] of [
      ["default DOM", ""],
      ["reshuffled DOM (heuristic fallback)", "?dom=changed"],
    ]) {
      const page = await browser.newPage();
      await page.goto(`${base}/${qs}`);
      await page.waitForSelector("#composer", { timeout: 5000 }).catch(() => {});
      const r = await page.evaluate(PROBE);
      const ok = r.composerFound === true;
      results.push({ label, ok, r });
      console.log(`${ok ? "✔" : "✖"} self-check: composer found on ${label} (via ${r.via})`);
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(() => r()));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} self-checks passed`);
  process.exit(failed.length ? 1 : 0);
}

/** Print a prompt and resolve when the user presses Enter in the terminal. */
function waitForEnter(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(msg, () => {
      rl.close();
      resolve();
    });
  });
}

// --- live: probe the real surfaces in a logged-in profile --------------------
async function live() {
  console.error(`[selector-watch] profile: ${PROFILE_DIR}`);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
  const report = { at: new Date().toISOString(), send: WATCH_SEND, surfaces: [] };
  try {
    // In HOLD mode, open every surface up-front and keep those exact tabs, so
    // the panel you open by hand is the one that gets probed (a fresh navigation
    // would close it). Otherwise the loop opens+navigates per surface.
    const heldPages = new Map();
    if (HOLD) {
      for (const s of SURFACES) {
        const p = await ctx.newPage();
        await p.goto(s.url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        heldPages.set(s.name, p);
      }
      await waitForEnter(
        "\n[selector-watch] Log into Google and OPEN the 'Ask Gemini' panel in each tab.\n" +
          "Press Enter here when ready to probe... ",
      );
    }
    for (const surface of SURFACES) {
      const held = heldPages.get(surface.name);
      const page = held || (await ctx.newPage());
      const entry = { name: surface.name, url: surface.url, requiresPanel: surface.requiresPanel };
      try {
        if (!held) {
          await page.goto(surface.url, { waitUntil: "domcontentloaded", timeout: 45000 });
          // Give SPA + (for Workspace) a manually-opened panel time to render.
          await page.waitForTimeout(surface.requiresPanel ? 8000 : 4000);
        }
        const r = await page.evaluate(PROBE);
        Object.assign(entry, r);

        // Deep check (opt-in): actually send a PII probe and confirm the
        // outbound request body is tokenized on the wire. Only on surfaces that
        // don't need a manually-opened panel + where a composer was found; uses
        // the SAME endpoint list as the tripwire to know which request to read.
        if (WATCH_SEND && !surface.requiresPanel && r.composerFound) {
          const PROBE_EMAIL = "watchprobe" + "@" + "example.com";
          const captured = [];
          const onReq = (req) => {
            if (!shouldInspectUrl(req.url())) return;
            const body = req.postData() || "";
            if (body) captured.push(body);
          };
          page.on("request", onReq);
          try {
            await page.evaluate(() => {
              const el =
                document.querySelector('div.ql-editor[contenteditable="true"]') ||
                document.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
              if (el) el.focus();
            });
            await page.keyboard.type(`please email ${PROBE_EMAIL}`);
            await page.keyboard.press("Enter");
            await page.waitForTimeout(6000);
          } finally {
            page.off("request", onReq);
          }
          const anyRaw = captured.some((b) => b.includes("example.com"));
          const anyToken = captured.some((b) => b.includes("[REDACTED_PII_EMAIL]"));
          entry.sendChecked = true;
          entry.wireHadRaw = anyRaw;
          entry.wireTokenized = anyToken;
          entry.capturedRequests = captured.length;
        }
      } catch (e) {
        entry.error = String(e && e.message ? e.message : e);
        entry.composerFound = false;
      }
      const flag = entry.composerFound ? "✔" : surface.requiresPanel ? "⚠" : "✖";
      console.log(`${flag} ${surface.name}: composerFound=${entry.composerFound} via=${entry.via || "-"}`);
      report.surfaces.push(entry);
      await page.close();
    }
  } finally {
    await ctx.close();
  }

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.error(`[selector-watch] report: ${REPORT_PATH}`);

  // Fail (non-zero) only when a surface that should ALWAYS have a composer is
  // missing it — a Workspace panel that was simply closed (requiresPanel) is a
  // warning, not a hard failure, to avoid false alerts.
  const hardFail = report.surfaces.filter(
    (s) => (!s.requiresPanel && !s.composerFound) || s.wireHadRaw === true,
  );
  if (hardFail.length) {
    console.error(`[selector-watch] BROKEN on: ${hardFail.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
}

if (SELF_CHECK) await selfCheck();
else await live();
