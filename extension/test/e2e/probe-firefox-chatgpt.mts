// ===== FIREFOX x CHATGPT: does the redacted write SYNC into ProseMirror? =====
// The one Firefox-specific risk left for the ChatGPT surface. Gecko already
// FAILS this on the Google Workspace panels: `writeText` updates the visible
// text but Gemini's Angular model keeps the raw value, so the raw PII is XHR'd
// and the tripwire has to abort the send (no leak, but the message can't be
// sent). ChatGPT's composer is ProseMirror — a different editor, so the answer
// has to be measured, not assumed.
//
// WHY THIS NEEDS NO LOGIN AND SENDS NOTHING: the composer is rendered on the
// unauthenticated page, and sync is observable without submitting. ProseMirror
// re-renders the DOM from its own document model, so:
//
//   1. type the raw text with TRUSTED keys   -> model = raw,   DOM = raw
//   2. apply writeText (select-all + execCommand insertText)
//                                            -> DOM = token
//   3. type ONE more trusted key             -> ProseMirror renders model+key
//
// If step 2 went through ProseMirror's input pipeline, step 3 leaves the token
// in place. If it only touched the DOM, step 3 renders the STALE model and the
// token is wiped — which is exactly what would ship raw PII. Step 3 is the real
// assertion; the DOM right after step 2 looks correct in BOTH cases, which is
// why the Workspace bug survived a DOM-level check for so long.
//
// Trusted keys come from Marionette because the interceptor ignores
// `isTrusted:false` (that IS the loop guard) and, more importantly here, so does
// ProseMirror's own key handling.
//
//   npm run probe:firefox-chatgpt              # headless
//   npm run probe:firefox-chatgpt -- --show    # watch it
//
// Exits non-zero if the write does not sync.

import { join } from "node:path";
import { launchFirefox } from "./firefox-rdp.mts";
import { connectMarionette } from "./firefox-marionette.mts";

const URL_UNDER_TEST = "https://chatgpt.com/";
const ADDON = join(process.cwd(), "extension", "build", "firefox");
const MARIONETTE_PORT = 2830;
const HEADLESS = !process.argv.includes("--show");

// Assembled at runtime so no PII literal is ever stored in the repo.
const RAW = ["dana", ".", "reyes", "@", "corp", ".com"].join("");
const TOKEN = "[REDACTED_PII_EMAIL]";
const EXTRA_KEY = "!";

const COMPOSER = '#prompt-textarea[contenteditable="true"], div#prompt-textarea';

/** Exactly the contenteditable branch of composer.js `writeText`. */
const WRITE_TEXT = `
  const el = document.querySelector(${JSON.stringify(COMPOSER)});
  if (!el) return "no-composer";
  el.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.addRange(range);
  return String(document.execCommand("insertText", false, ${JSON.stringify(TOKEN)}));
`;

const READ = `
  const el = document.querySelector(${JSON.stringify(COMPOSER)});
  return el ? (el.textContent || "") : null;
`;

function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok && detail !== undefined) console.log("      ", JSON.stringify(detail));
  if (!ok) process.exitCode = 1;
}

const session = await launchFirefox({
  url: "about:blank",
  headless: HEADLESS,
  marionettePort: MARIONETTE_PORT,
});
let marionette: Awaited<ReturnType<typeof connectMarionette>> | null = null;
try {
  const { id } = await session.installAddon(ADDON);
  console.log(`installed ${id}; opening ${URL_UNDER_TEST}`);

  marionette = await connectMarionette(MARIONETTE_PORT);
  await marionette.newSession();
  await marionette.navigate(URL_UNDER_TEST);

  // The composer is rendered by the SPA, so poll rather than assume.
  let present = false;
  for (let i = 0; i < 60 && !present; i++) {
    present = (await marionette.executeScript(`return !!document.querySelector(${JSON.stringify(COMPOSER)});`)) === true;
    if (!present) await new Promise((r) => setTimeout(r, 500));
  }
  check("composer found on the unauthenticated page", present);
  if (!present) throw new Error("no composer — the logged-out layout may have changed");

  // Positive control: the MAIN-world module is actually running here, so a
  // sync failure below cannot be blamed on the extension not loading.
  const tripwire = await marionette.executeScript(`return !String(window.fetch).includes('native code');`);
  check("MAIN-world module is live on this page (tripwire installed)", tripwire === true, { tripwire });

  // ---- step 1: raw text via TRUSTED keys -> ProseMirror model = raw ----------
  const el = await marionette.findElement(COMPOSER);
  await marionette.click(el);
  await marionette.sendKeys(el, RAW);
  const afterTyping = String(await marionette.executeScript(READ));
  check("trusted typing reached the composer", afterTyping.includes(RAW), { afterTyping });

  // ---- step 2: the redacted write -------------------------------------------
  const wrote = await marionette.executeScript(WRITE_TEXT);
  const afterWrite = String(await marionette.executeScript(READ));
  check("execCommand insertText reported success", String(wrote) === "true", { wrote });
  check("DOM shows the token after the write", afterWrite.includes(TOKEN), { afterWrite });
  check("DOM no longer shows raw PII after the write", !afterWrite.includes(RAW), { afterWrite });

  // ---- step 3: THE REAL TEST — one more trusted key --------------------------
  // ProseMirror re-renders from its own model here. A stale model wipes the token.
  await marionette.sendKeys(el, EXTRA_KEY);
  const afterKey = String(await marionette.executeScript(READ));
  const synced = afterKey.includes(TOKEN) && !afterKey.includes(RAW);
  check("ProseMirror MODEL took the redacted write (survives a real keystroke)", synced, { afterKey });

  console.log(
    synced
      ? "\nRESULT: Firefox syncs the redacted write into ChatGPT's ProseMirror model.\n" +
          "        The Workspace-panel failure does NOT apply to chatgpt.com."
      : "\nRESULT: Firefox does NOT sync the write into ProseMirror — the model kept the\n" +
          "        raw text, so a PII send would be aborted by the tripwire (fail-closed,\n" +
          "        no leak) exactly like the Gemini Workspace panels on Firefox.",
  );
} finally {
  marionette?.close();
  session.close();
}
