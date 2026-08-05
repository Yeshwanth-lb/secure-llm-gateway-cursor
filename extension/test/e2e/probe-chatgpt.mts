// ===== PROBE — can we write redacted text into ChatGPT's composer? ==========
// THE make-or-break check for the ChatGPT surface (CHATGPT_EXTENSION.md §5).
// ChatGPT's composer is ProseMirror, which keeps its OWN document model and can
// ignore direct DOM edits. If a synthetic write updates the visible text but not
// the model, ChatGPT would send the RAW prompt (the tripwire would abort it) —
// fail-closed but broken UX. That must be proven BEFORE building the adapter.
//
// This probe does exactly what the extension will do, minus the extension:
//   1. type the RAW prompt with TRUSTED keystrokes (as a user would),
//   2. replace it using one candidate write strategy,
//   3. submit and read the OUTGOING /backend-api/conversation request body.
// Verdict is the wire, not the DOM: token on the wire = the model synced.
//
// It needs a logged-in browser, so it runs HEADFUL against a persistent profile
// (cookies persist between runs — log in once). Nothing here ships; it is a
// diagnostic, like scripts/selector-watch.mjs.
//
//   npm run probe:chatgpt                 # report the composer DOM only
//   npm run probe:chatgpt -- --send       # + write + submit + read the wire
//   npm run probe:chatgpt -- --send --strategy=paste
//
// The probe value is a synthetic address; no real PII is typed anywhere.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Extension runs need their OWN profile: they must use Chrome for Testing (see
// below), and cookies are encrypted with a per-build macOS Keychain key, so a
// login made in branded Chrome cannot be reused there.
const PROFILE_SUFFIX = process.argv.includes("--extension") ? "-ext" : "";
const PROFILE_DIR = (
  process.env.CHATGPT_PROBE_PROFILE ||
  path.join(os.homedir(), ".secure-llm-gateway", `chatgpt-probe-profile${PROFILE_SUFFIX}`)
).replace(/^~(?=$|\/)/, os.homedir());
const REPORT_PATH = path.join(os.homedir(), ".secure-llm-gateway", "chatgpt-probe-report.json");
const URL_UNDER_TEST = process.env.CHATGPT_URL || "https://chatgpt.com/";

const DO_SEND = process.argv.includes("--send");
// Load the REAL unpacked extension and let it do the work — the live acceptance
// check (CHATGPT_EXTENSION.md §8): a PII prompt leaves as a token, a normal
// prompt still sends and replies, and the turn reaches the gateway's log.
const DO_EXTENSION = process.argv.includes("--extension");
// Read-only selector survey (types into the composer but never submits): the
// send/stop buttons, the model switcher and the assistant-reply markup the
// ChatGPT adapter needs. Confirms §4 of the spec against the live page.
const DO_INSPECT = process.argv.includes("--inspect");
const ONLY = (process.argv.find((a) => a.startsWith("--strategy=")) || "").split("=")[1] || "";
const HEADLESS = process.argv.includes("--headless");

// Synthetic probe value + the token the gateway would produce for it.
const PROBE_EMAIL = "probe.person" + "@" + "example.com";
const TOKEN = "[REDACTED_PII_EMAIL]";
const RAW_PROMPT = `Reply with the single word OK. Contact: ${PROBE_EMAIL}`;
const REDACTED_PROMPT = `Reply with the single word OK. Contact: ${TOKEN}`;

// The endpoint ChatGPT posts a message to (CHATGPT_EXTENSION.md §4). Matched
// loosely so a path change (/backend-api/f/conversation, /backend-alt/...) is
// still captured and REPORTED rather than silently missed.
const CONVERSATION_URL = /\/backend-a[^/]*\/(?:f\/)?conversation(?:$|\?)/;

/** Runs IN the page: describe every plausible composer + the send controls. */
function DESCRIBE() {
  const info: Record<string, unknown> = { href: location.href, title: document.title };
  const el = document.querySelector("#prompt-textarea");
  const describe = (n: Element | null) =>
    n
      ? {
          tag: n.tagName.toLowerCase(),
          id: (n as HTMLElement).id || "",
          className: typeof n.className === "string" ? n.className : "",
          contentEditable: (n as HTMLElement).getAttribute("contenteditable"),
          isProseMirror: typeof n.className === "string" && /ProseMirror/.test(n.className),
          childHTML: (n as HTMLElement).innerHTML.slice(0, 200),
          rect: (() => {
            const r = n.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
          })(),
        }
      : null;
  info.promptTextarea = describe(el);
  info.textareas = Array.from(document.querySelectorAll("textarea")).map((t) => ({
    ...describe(t),
    name: t.name,
    hidden: t.offsetParent === null,
    valueLen: t.value.length,
    // A ProseMirror mirror textarea would live in the same form as the editor.
    sameFormAsEditor: !!(el && t.form && t.form.contains(el)),
  }));
  info.sendButtons = Array.from(document.querySelectorAll("button[data-testid]"))
    .map((b) => ({
      testid: b.getAttribute("data-testid"),
      disabled: (b as HTMLButtonElement).disabled,
      visible: (b as HTMLElement).offsetParent !== null,
      ariaLabel: b.getAttribute("aria-label"),
    }))
    .filter((b) => /send|stop|submit|speech/i.test(b.testid || ""));
  info.loginWall = !!document.querySelector('[data-testid="login-button"], [href*="/auth/login"]');
  return info;
}

/** Runs IN the page: survey the reply/model/send markup for the adapter. */
function SURVEY() {
  const brief = (n: Element) => ({
    tag: n.tagName.toLowerCase(),
    testid: n.getAttribute("data-testid"),
    ariaLabel: n.getAttribute("aria-label"),
    className: typeof n.className === "string" ? n.className.slice(0, 120) : "",
    text: ((n as HTMLElement).innerText || "").trim().slice(0, 80),
  });
  const q = (sel: string) => Array.from(document.querySelectorAll(sel)).map(brief);
  return {
    buttons: Array.from(document.querySelectorAll("button[data-testid], button[aria-label]"))
      .filter((b) => /send|stop|submit|model/i.test((b.getAttribute("data-testid") || "") + (b.getAttribute("aria-label") || "")))
      .map((b) => ({ ...brief(b), disabled: (b as HTMLButtonElement).disabled, visible: (b as HTMLElement).offsetParent !== null })),
    modelSwitcher: q('[data-testid="model-switcher-dropdown-button"], [data-testid*="model-switcher"]'),
    assistantTurns: q('[data-message-author-role="assistant"]').length,
    userTurns: q('[data-message-author-role="user"]').length,
    assistantMarkdown: q('[data-message-author-role="assistant"] .markdown'),
    lastAssistantText: (() => {
      const els = document.querySelectorAll('[data-message-author-role="assistant"]');
      const last = els[els.length - 1] as HTMLElement | undefined;
      return last ? (last.innerText || "").trim().slice(0, 160) : null;
    })(),
    conversationLinks: Array.from(document.querySelectorAll('a[href^="/c/"]')).length,
  };
}

/**
 * Runs IN the page. Replace the composer's content with `text` using one
 * strategy, then report what the DOM reads back. Strategies mirror what
 * composer.js could plausibly do; the wire decides which actually works.
 */
function WRITE(args: { strategy: string; text: string }) {
  const { strategy, text } = args;
  const editor = document.querySelector("#prompt-textarea") as HTMLElement | null;
  const out: Record<string, unknown> = { strategy, found: !!editor };
  if (!editor) return out;
  const isTextarea = editor.tagName.toLowerCase() === "textarea";
  editor.focus();

  const selectAll = () => {
    if (isTextarea) {
      (editor as unknown as HTMLTextAreaElement).setSelectionRange(0, (editor as HTMLTextAreaElement).value.length);
      return;
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  try {
    if (strategy === "textarea") {
      // The "easy path" CHATGPT_EXTENSION.md §5 says to check first: a companion
      // <textarea> that the request is actually built from.
      const ta =
        (editor as unknown as HTMLTextAreaElement).tagName?.toLowerCase() === "textarea"
          ? (editor as unknown as HTMLTextAreaElement)
          : (document.querySelector("textarea") as HTMLTextAreaElement | null);
      out.target = ta ? ta.name || ta.id || "textarea" : null;
      if (!ta) return { ...out, applied: false, reason: "no textarea on the page" };
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), "value");
      if (desc?.set) desc.set.call(ta, text);
      else ta.value = text;
      ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      out.applied = true;
    } else if (strategy === "paste") {
      selectAll();
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      out.applied = editor.dispatchEvent(ev);
      out.defaultPrevented = ev.defaultPrevented;
    } else if (strategy === "beforeinput") {
      selectAll();
      const ev = new InputEvent("beforeinput", {
        inputType: "insertReplacementText",
        data: text,
        bubbles: true,
        cancelable: true,
      });
      out.applied = editor.dispatchEvent(ev);
      out.defaultPrevented = ev.defaultPrevented;
    } else if (strategy === "exec") {
      // The Gemini path (execCommand insertText) — the one expected to fail here.
      selectAll();
      out.applied = document.execCommand("insertText", false, text);
    }
  } catch (e) {
    out.error = String((e as Error)?.message || e);
  }
  out.editorText = (editor as HTMLElement).innerText ?? "";
  const ta0 = document.querySelector("textarea") as HTMLTextAreaElement | null;
  out.firstTextareaValue = ta0 ? ta0.value : null;
  return out;
}

/**
 * Block until the page is logged in with a usable composer. Polling (not a
 * terminal prompt) so the probe can run unattended in the background while the
 * human logs into ChatGPT in the window it opened. Cookies persist in the
 * profile dir, so this only blocks on the first run.
 */
async function waitForLogin(page: Page, timeoutMs = 10 * 60_000): Promise<boolean> {
  const started = Date.now();
  let announced = false;
  while (Date.now() - started < timeoutMs) {
    const dom = (await page.evaluate(DESCRIBE).catch(() => null)) as { loginWall?: boolean; promptTextarea?: unknown } | null;
    if (dom && dom.loginWall === false && dom.promptTextarea) return true;
    if (!announced) {
      console.error(
        "\n[probe] NOT logged in yet. Log into ChatGPT in the browser window that just opened;\n" +
          "        the probe continues automatically once a composer is available.\n",
      );
      announced = true;
    }
    await page.waitForTimeout(3000);
  }
  return false;
}

/** Type the raw prompt with TRUSTED keystrokes, like a real user. */
async function typeRaw(page: Page) {
  await page.click("#prompt-textarea");
  await page.keyboard.type(RAW_PROMPT, { delay: 12 });
  await page.waitForTimeout(200);
}

/** Clear the composer between attempts (trusted select-all + Backspace). */
async function clearComposer(page: Page) {
  await page.click("#prompt-textarea").catch(() => {});
  await page.keyboard.press("ControlOrMeta+a").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.waitForTimeout(150);
}

type Attempt = {
  strategy: string;
  write: Record<string, unknown>;
  urls: string[];
  bodies: string[];
  sawToken: boolean;
  sawRaw: boolean;
  verdict: string;
};

async function attempt(page: Page, strategy: string): Promise<Attempt> {
  const bodies: string[] = [];
  const urls: string[] = [];
  const onReq = (req: import("playwright").Request) => {
    if (!CONVERSATION_URL.test(req.url())) return;
    const body = req.postData();
    if (body) {
      bodies.push(body);
      urls.push(req.url());
    }
  };
  page.on("request", onReq);
  try {
    await clearComposer(page);
    await typeRaw(page);
    const write = (await page.evaluate(WRITE, { strategy, text: REDACTED_PROMPT })) as Record<string, unknown>;
    await page.waitForTimeout(300);
    // Submit with a TRUSTED Enter: this step isolates the WRITE (model sync).
    // The synthetic re-fire is a separate risk, covered once the write is proven.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(6000);
    const joined = bodies.join("\n");
    const sawToken = joined.includes(TOKEN);
    const sawRaw = joined.includes(PROBE_EMAIL);
    return {
      strategy,
      write,
      urls,
      bodies: bodies.map((b) => b.slice(0, 400)),
      sawToken,
      sawRaw,
      verdict: bodies.length === 0 ? "NO REQUEST CAPTURED" : sawRaw ? "RAW ON THE WIRE (model did not sync)" : sawToken ? "TOKEN ON THE WIRE (model synced)" : "neither raw nor token found",
    };
  } finally {
    page.off("request", onReq);
  }
}

const EXT_DIR = path.resolve(HERE, "../..");
const GATEWAY = process.env.GATEWAY_BASE || "http://127.0.0.1:8001";

/**
 * Live acceptance run WITH the extension installed. Types a prompt with trusted
 * keystrokes and lets the extension intercept/redact/re-fire — nothing here
 * touches the composer itself, so what it reports is the shipped behavior.
 */
async function extensionRun(page: Page) {
  const seen: { url: string; body: string }[] = [];
  const console_: string[] = [];
  page.on("request", (req) => {
    if (!CONVERSATION_URL.test(req.url())) return;
    const body = req.postData();
    if (body) seen.push({ url: req.url(), body });
  });
  // Anything the extension logs — "content script active", a fail-closed warning,
  // a loader/CSP refusal. Silence here means the extension never ran.
  page.on("console", (m) => {
    const t = m.text();
    if (/redact|tripwire|Content Security|blocked/i.test(t)) console_.push(`${m.type()}: ${t.slice(0, 200)}`);
  });

  /** Is the extension actually live in this page? */
  const diagnose = () =>
    page.evaluate(() => {
      const w = window as unknown as { __probeBlocked__?: string[] };
      return {
        // The tripwire replaces window.fetch, so a non-native fetch proves the
        // MAIN-world module ran.
        fetchWrapped: !String(window.fetch).includes("[native code]"),
        blocked: w.__probeBlocked__ || [],
      };
    });

  const send = async (text: string) => {
    const before = seen.length;
    await page.evaluate(() => {
      const w = window as unknown as { __probeBlocked__?: string[] };
      if (!w.__probeBlocked__) {
        w.__probeBlocked__ = [];
        window.addEventListener("gemini-redact:blocked", (e) =>
          w.__probeBlocked__!.push(String((e as CustomEvent).detail?.reason || "?")),
        );
      }
    });
    await page.click("#prompt-textarea");
    // Clear any draft ChatGPT restored, or the typing appends to it.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(text, { delay: 12 });
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(12000);
    return seen.slice(before);
  };

  const beforeSend = await diagnose();
  // 1. A PII prompt must leave as a token, exactly once.
  const pii = await send(RAW_PROMPT);
  const piiBodies = pii.map((s) => s.body).join("\n");
  // 2. A normal prompt must still send and reply — the Firefox-Workspace failure
  //    mode was "PII blocked AND normal sends broken".
  await page.goto(URL_UNDER_TEST, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForSelector("#prompt-textarea", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const plain = await send("Reply with the single word FINE.");
  const reply = await page
    .evaluate(() => {
      const els = document.querySelectorAll('[data-message-author-role="assistant"]');
      const last = els[els.length - 1] as HTMLElement | undefined;
      return last ? (last.innerText || "").trim().slice(0, 120) : "";
    })
    .catch(() => "");

  // 3. The turn must be in the gateway's traffic log as a provider:openai row.
  let logged: unknown = null;
  try {
    const res = await fetch(`${GATEWAY}/logs?clean=1`);
    const json = (await res.json()) as { entries: any[] };
    logged = json.entries
      .filter((e) => e.path === "chatgpt-web-extension")
      .slice(0, 3)
      .map((e) => ({
        provider: e.provider,
        model: e.model,
        method: e.method,
        piiDetected: e.piiDetected,
        matched: e.matchedRules?.inbound,
        userPrompt: String(e.clean?.userPrompt || "").slice(0, 120),
        assistantOutput: String(e.clean?.assistantOutput || "").slice(0, 120),
      }));
  } catch (e) {
    logged = { error: String((e as Error).message) };
  }

  return {
    extensionLive: beforeSend,
    consoleLines: console_.slice(0, 20),
    piiSendCount: pii.length,
    piiUrls: pii.map((s) => s.url),
    piiWireToken: piiBodies.includes(TOKEN),
    piiWireRaw: piiBodies.includes(PROBE_EMAIL),
    piiBodySample: piiBodies.slice(0, 300),
    plainSendCount: plain.length,
    plainWire: plain.map((s) => s.body.slice(0, 200)),
    plainReply: reply,
    gatewayRows: logged,
  };
}

// BRANDED Chrome (137+) silently IGNORES `--load-extension` — the flag was
// removed to stop malware side-loading (Chrome blog, June 2025). An extension run
// there loads NOTHING and the page is simply unprotected, which looks exactly
// like a redaction failure. Chrome for Testing (Playwright's bundled `chromium`)
// still honours the flag, so extension runs must use it.
const CHANNEL = process.env.CHATGPT_PROBE_CHANNEL || (DO_EXTENSION ? "chromium" : "chrome");
const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: HEADLESS,
  channel: CHANNEL,
  viewport: { width: 1280, height: 900 },
  // MV3 extensions need a headed browser; this probe is headful by default.
  args: DO_EXTENSION ? [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`] : [],
});
const report: Record<string, unknown> = { at: new Date().toISOString(), url: URL_UNDER_TEST, profile: PROFILE_DIR };
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(URL_UNDER_TEST, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.waitForSelector("#prompt-textarea", { timeout: 30000 }).catch(() => {});

  report.dom = await page.evaluate(DESCRIBE);
  console.log("\n=== composer DOM ===");
  console.log(JSON.stringify(report.dom, null, 2));

  if (DO_INSPECT) {
    const ready = await waitForLogin(page);
    report.loggedIn = ready;
    // With text in the composer the send button exists (it replaces the mic).
    await page.click("#prompt-textarea").catch(() => {});
    await page.keyboard.type("hello", { delay: 10 });
    await page.waitForTimeout(500);
    report.surveyComposerFilled = await page.evaluate(SURVEY);
    console.log("\n=== survey: composer with text ===");
    console.log(JSON.stringify(report.surveyComposerFilled, null, 2));
    // Open the most recent conversation to survey the assistant-reply markup.
    const firstConv = page.locator('a[href^="/c/"]').first();
    if (await firstConv.count()) {
      await firstConv.click();
      await page.waitForTimeout(4000);
      report.surveyConversation = await page.evaluate(SURVEY);
      console.log("\n=== survey: existing conversation ===");
      console.log(JSON.stringify(report.surveyConversation, null, 2));
    }
  }

  if (DO_EXTENSION) {
    // Confirm the extension REALLY loaded before drawing any conclusion from the
    // wire. A browser that ignored `--load-extension` sends raw PII simply because
    // nothing is installed — indistinguishable from a broken redaction path unless
    // this is checked first.
    let workers = ctx.serviceWorkers().map((w) => w.url());
    for (let i = 0; i < 10 && workers.length === 0; i++) {
      await page.waitForTimeout(500);
      workers = ctx.serviceWorkers().map((w) => w.url());
    }
    report.extensionWorkers = workers;
    if (!workers.some((u) => u.startsWith("chrome-extension://"))) {
      throw new Error(
        `the extension did not load (channel "${CHANNEL}"): no chrome-extension:// service worker. ` +
          "Branded Chrome 137+ ignores --load-extension; use Chrome for Testing (channel chromium).",
      );
    }
    const ready = await waitForLogin(page);
    report.loggedIn = ready;
    if (!ready) throw new Error("timed out waiting for a logged-in ChatGPT composer");
    const r = await extensionRun(page);
    report.extension = r;
    console.log("\n=== live run WITH the extension loaded ===");
    console.log(JSON.stringify(r, null, 2));
    const ok = r.piiSendCount === 1 && r.piiWireToken && !r.piiWireRaw && r.plainSendCount === 1 && !!r.plainReply;
    console.log(
      ok
        ? "\n>>> LIVE ACCEPTANCE PASS: PII prompt tokenized on the wire, normal prompt sent + replied."
        : "\n>>> LIVE ACCEPTANCE FAIL — see the report above.",
    );
  }

  if (DO_SEND) {
    const ready = await waitForLogin(page);
    report.loggedIn = ready;
    if (!ready) throw new Error("timed out waiting for a logged-in ChatGPT composer");
    const order = ONLY ? [ONLY] : ["textarea", "paste", "beforeinput", "exec"];
    const attempts: Attempt[] = [];
    for (const strategy of order) {
      console.log(`\n=== attempt: ${strategy} ===`);
      const a = await attempt(page, strategy);
      attempts.push(a);
      console.log(JSON.stringify(a, null, 2));
      if (a.sawToken && !a.sawRaw) {
        console.log(`\n>>> WRITE PROVEN with strategy "${strategy}": token on the wire, no raw PII.`);
        break;
      }
      // Start a fresh conversation so the next attempt is independent.
      await page.goto(URL_UNDER_TEST, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForSelector("#prompt-textarea", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    report.attempts = attempts;
  }
} finally {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.error(`\n[probe] report: ${REPORT_PATH}`);
  await ctx.close();
}
