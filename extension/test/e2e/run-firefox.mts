// ===== FIREFOX PORT E2E — real Firefox, real extension, real gateway =======
// `run.mts` (Chromium/Playwright) drives content-main.js DIRECTLY, with the page
// itself answering the redact event. That covers the browser-AGNOSTIC core but
// exercises none of the files the cross-browser port actually changed:
// manifest.json, browser-api.js, content-bridge.js, loader.js, background.js.
//
// So this harness installs the REAL built extension into a REAL Firefox (via the
// remote-debugging protocol, the one thing `web-ext` is needed for — reimplemented
// in firefox-rdp.mts so no dependency is added) and drives it with TRUSTED input
// over Marionette, because the loop guard ignores `isTrusted:false` events.
//
// What it proves on Firefox specifically:
//   1. the ISOLATED content scripts load and the `browser`/`chrome` shim resolves
//      (only content-bridge.js emits the config event the page records);
//   2. loader.js gets the MAIN-world ES module running even though Firefox applies
//      the PAGE's CSP to script tags a content script inserts — tested against a
//      CSP copied from gemini.google.com, including 'strict-dynamic';
//   3. the background EVENT PAGE (Firefox has no MV3 service worker) reaches the
//      loopback gateway and the gateway's CORS grant covers `moz-extension://`;
//   4. a real keystroke-driven submit sends REDACTED text and never the raw PII —
//      i.e. composer.writeText's model-sync works in Gecko too;
//   5. gateway unreachable still FAILS CLOSED (nothing sent).
//
// Not part of `npm test`: needs a browser. Run:
//   npm run test:firefox-e2e

import http from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../../../secure-llm-gateway.ts";
import { buildExtension } from "../../../scripts/build-extension.mjs";
import { launchFirefox } from "./firefox-rdp.mts";
import { connectMarionette, ENTER } from "./firefox-marionette.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADDON_ID = "gemini-pii-redaction@secure-llm-gateway.local";

// PII the gateway must replace. Built from parts so this file never contains a
// literal that a PII scanner would flag.
const RAW_EMAIL = ["dana", ".", "reyes", "@", "corp", ".com"].join("");
const PROMPT = `email me at ${RAW_EMAIL} thanks`;

// A CSP with the directives that make gemini.google.com the hard case: a nonce
// plus 'strict-dynamic', under which host allowlists are ignored and only
// nonce-approved scripts (and scripts they insert) may run. If Firefox applied
// this to our extension-origin script the MAIN module would never load.
const GEMINI_LIKE_CSP =
  "script-src 'nonce-harness' 'unsafe-inline' 'unsafe-eval' 'strict-dynamic' https: http:; object-src 'none'; base-uri 'self'";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS " : "FAIL "} ${label}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log("        got:", detail);
  }
}

/**
 * Repoint a built copy at a closed port so the fail-closed path can be exercised
 * without touching the gateway on 8001. Only the default base is rewritten — the
 * intercept and fail-closed logic under test is untouched.
 */
async function pointAtDeadGateway(dir: string) {
  const dead = "http://127.0.0.1:1";
  for (const file of ["src/content-bridge.js", "src/background.js"]) {
    const path = join(dir, file);
    const src = await readFile(path, "utf8");
    await writeFile(path, src.replaceAll("http://127.0.0.1:8001", dead));
  }
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions.push(`${dead}/*`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

/** Serve the fake Gemini page under a Gemini-like CSP. */
async function servePage() {
  const html = await readFile(join(HERE, "firefox-page.html"), "utf8");
  const server = http.createServer((req, res) => {
    if ((req.url ?? "/").startsWith("/health")) {
      res.writeHead(200).end("ok");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": GEMINI_LIKE_CSP,
    });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { server, origin: `http://127.0.0.1:${port}` };
}

/** Read the page's recorded state (stringified in-page, so it crosses as a primitive). */
async function pageState(session: Awaited<ReturnType<typeof launchFirefox>>, origin: string) {
  const raw = await session.evalInTab(
    new URL(origin).port,
    `JSON.stringify({
       href: location.href,
       pageScriptRan: Array.isArray(window.__sent__),
       sent: window.__sent__ || [],
       blocked: window.__blocked__ || [],
       configSeen: !!window.__config__,
       configBase: (window.__config__ || {}).base || null,
       tripwireInstalled: !String(window.fetch).includes('native code')
     })`,
  );
  return JSON.parse(String(raw));
}

// The extension's gateway base is configuration (storage.managed/local), and on
// Firefox managed storage lives OUTSIDE the profile (~/Library/Application
// Support/Mozilla/ManagedStorage), so a test cannot seed it without touching the
// machine. Rather than patch the built defaults — which would stop testing the
// artifact users load — the harness takes the extension's real default port,
// 8001. If another gateway already owns it (the installed service), the happy
// path runs against that one and the fail-closed case, which needs to kill the
// gateway, is skipped rather than faked.
const GATEWAY_PORT = 8001;
const gatewayBase = `http://127.0.0.1:${GATEWAY_PORT}`;
const gateway = createGatewayServer({ adminToken: "" });
const ownsGateway = await new Promise<boolean>((resolve) => {
  gateway.once("error", (e: NodeJS.ErrnoException) => resolve(e.code !== "EADDRINUSE" ? Promise.reject(e) as never : false));
  gateway.listen(GATEWAY_PORT, "127.0.0.1", () => resolve(true));
});
if (!ownsGateway) {
  const reachable = await fetch(`${gatewayBase}/healthz`).then((r) => r.ok).catch(() => false);
  if (!reachable) {
    console.error(`port ${GATEWAY_PORT} is busy but is not a healthy gateway — free it and retry`);
    process.exit(1);
  }
  console.log(`note: port ${GATEWAY_PORT} already serves a healthy gateway — reusing it for the happy path`);
}
const { server: pageServer, origin } = await servePage();

// Build a Firefox package whose match patterns also cover the local test origin.
// Everything else — background type, gecko settings — comes from the shared
// `firefox` target, so the artifact under test is the one users load.
const out = await mkdtemp(join(tmpdir(), "gemini-redact-ffbuild-"));
const addonDir = await buildExtension("firefox", {
  out,
  patch: (manifest: any) => {
    // Match patterns cannot carry a port, so this covers the ephemeral page port
    // (and the gateway, which the content scripts never talk to directly anyway).
    const pattern = "http://127.0.0.1/*";
    manifest.content_scripts[0].matches.push(pattern);
    manifest.web_accessible_resources[0].matches.push(pattern);
    return manifest;
  },
});

console.log(`gateway ${gatewayBase}\npage    ${origin}\naddon   ${addonDir}`);

const MARIONETTE_PORT = 2828;

/** Launch Firefox, install `addonDir`, open the fake page, and type `prompt` + Enter. */
async function typeAndSubmit(addonDir: string, prompt: string) {
  const session = await launchFirefox({ url: "about:blank", marionettePort: MARIONETTE_PORT });
  let marionette: Awaited<ReturnType<typeof connectMarionette>> | null = null;
  try {
    await session.installAddon(addonDir);
    const bg = await session.backgroundStatus(ADDON_ID);
    marionette = await connectMarionette(MARIONETTE_PORT);
    await marionette.newSession();
    await marionette.navigate(origin); // content scripts inject on load
    await new Promise((r) => setTimeout(r, 2000));
    const boot = await pageState(session, origin);

    const composer = await marionette.findElement("#composer");
    await marionette.click(composer);
    await marionette.sendKeys(composer, prompt);
    await marionette.sendKeys(composer, ENTER);
    // Long enough for the gateway round trip, and for the MAIN-world redact
    // timeout (5s) to expire on the unreachable-gateway path.
    await new Promise((r) => setTimeout(r, 8000));
    return { bg, boot, after: await pageState(session, origin) };
  } finally {
    marionette?.close();
    session.close();
  }
}

try {
  // ---- happy path: the pristine Firefox build against a live gateway ----
  const live = await typeAndSubmit(addonDir, PROMPT);
  check("Firefox accepted the manifest with no warnings", live.bg.warnings.length === 0, live.bg.warnings);
  check("background event page is running (no MV3 service worker in Firefox)", live.bg.status === "RUNNING", live.bg.status);
  check("content script ran in Firefox", live.boot.configSeen === true, live.boot);
  check("bridge relayed the gateway base into MAIN world", live.boot.configBase === gatewayBase, live.boot.configBase);
  check(
    "MAIN-world module loaded under a gemini-like CSP (nonce + strict-dynamic)",
    live.boot.tripwireInstalled === true,
    live.boot,
  );

  const sent = (live.after.sent || []).join("\n");
  check("exactly one send reached the page", (live.after.sent || []).length === 1, live.after.sent);
  check("sent text is redacted (token present)", sent.includes("[REDACTED_PII_EMAIL]"), sent);
  check("sent text has NO raw PII", !sent.includes(RAW_EMAIL), sent);
  check("nothing was blocked on the happy path", (live.after.blocked || []).length === 0, live.after.blocked);

  // ---- failure path: an unreachable gateway must FAIL CLOSED ----
  // Pointed at a dead port via a second build rather than by stopping the
  // gateway, so the check is deterministic even when port 8001 belongs to an
  // installed gateway service this harness must not interfere with.
  const deadDir = await mkdtemp(join(tmpdir(), "gemini-redact-ffdead-"));
  await buildExtension("firefox", {
    out: deadDir,
    patch: (manifest: any) => {
      manifest.content_scripts[0].matches.push("http://127.0.0.1/*");
      manifest.web_accessible_resources[0].matches.push("http://127.0.0.1/*");
      return manifest;
    },
  });
  await pointAtDeadGateway(deadDir);

  const dead = await typeAndSubmit(deadDir, `second try ${RAW_EMAIL}`);
  check("gateway unreachable: nothing was sent", (dead.after.sent || []).length === 0, dead.after.sent);
  check(
    "gateway unreachable: user was told why",
    (dead.after.blocked || []).includes("gateway-unreachable"),
    dead.after.blocked,
  );
  check(
    "gateway unreachable: raw PII never reached the page",
    !(dead.after.sent || []).join("\n").includes(RAW_EMAIL),
    dead.after.sent,
  );
} finally {
  await new Promise<void>((r) => pageServer.close(() => r()));
  if (ownsGateway) gateway.close();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
