// ===== PROBE: does Firefox let the MAIN-world module load on a CSP'd page? ==
// The single highest-risk difference in the cross-browser port. Chrome exempts
// extension-origin scripts from a page's CSP; Firefox applies the page CSP to
// anything a content script inserts (Gecko bugs 1267027 / 1591983). Gemini
// serves `script-src 'nonce-…' 'strict-dynamic' …`, under which a
// programmatically inserted script with no nonce is refused.
//
// If the module never loads there is no interceptor and no tripwire, so a send
// would go out RAW — the one outcome the design forbids. This probe answers the
// question against the REAL page (no Google account needed: the CSP is served on
// the unauthenticated app URL too).
//
// Signals, in order of strength:
//   - `tripwireInstalled`: the MAIN module replaces `window.fetch` with a wrapper
//     (tripwire.js installTripwire), so a non-native `fetch` in the PAGE world is
//     positive proof the module loaded and ran. This is the one that matters.
//   - `cspBlockedLoader`: loader.js removes its <script> tag on `load`, so a tag
//     still sitting in the DOM means the load was refused. On its own this is
//     ambiguous (absent could also mean "never injected"), hence the pair.
//
//   node --experimental-strip-types extension/test/e2e/probe-firefox-csp.mts [url]

import { join } from "node:path";
import { launchFirefox } from "./firefox-rdp.mts";

const url = process.argv[2] ?? "https://gemini.google.com/app";
const addon = join(process.cwd(), "extension", "build", "firefox");

// Start on about:blank: content scripts inject on page LOAD, so the add-on has
// to be installed before the page under test is opened.
const session = await launchFirefox({ url: "about:blank" });
try {
  const { id } = await session.installAddon(addon);
  console.log(`installed ${id}; loading ${url}`);
  await session.navigate("about:blank", url);
  await new Promise((r) => setTimeout(r, 12000));
  const report = await session.evalInTab(
    new URL(url).hostname,
    `JSON.stringify({
       loc: location.href,
       tripwireInstalled: !String(window.fetch).includes('native code'),
       cspBlockedLoader: !!document.querySelector('script[data-gemini-redact]'),
       injectedSrc: (document.querySelector('script[data-gemini-redact]') || {}).src || null
     })`,
  );
  console.log("REPORT:", report);
  const ok = JSON.parse(String(report)).tripwireInstalled === true;
  console.log(ok ? "PASS  MAIN-world module runs under this page's CSP" : "FAIL  MAIN-world module did NOT run");
  if (!ok) process.exitCode = 1;
} finally {
  session.close();
}
