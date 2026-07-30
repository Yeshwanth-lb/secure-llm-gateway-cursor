#!/usr/bin/env node
// ===== CROSS-BROWSER EXTENSION PACKAGER (zero dependencies) ================
// Chrome loads `extension/` directly, so `extension/manifest.json` stays the
// Chrome manifest and the single source of truth for hosts, permissions and
// web-accessible resources. Firefox and Safari need a few manifest keys changed
// — not different code — so rather than keep three copies that drift, this
// script copies `extension/src` into `extension/build/<target>/` and writes a
// patched manifest beside it.
//
//   node scripts/build-extension.mjs firefox   -> extension/build/firefox
//   node scripts/build-extension.mjs safari    -> extension/build/safari
//   node scripts/build-extension.mjs           -> both
//
// Load the Firefox build via about:debugging -> "Load Temporary Add-on" (pick
// its manifest.json), and point `xcrun safari-web-extension-converter` at the
// Safari build. See extension/README.md.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extension");
const BUILD = join(EXT, "build");

/** Stable add-on id — Firefox needs one to key storage.local across reloads. */
const GECKO_ID = "gemini-pii-redaction@secure-llm-gateway.local";

/**
 * Neither Firefox nor Safari runs an MV3 background SERVICE WORKER the way
 * Chrome does — both use a non-persistent event page from `background.scripts`
 * (Firefox bug 1573659). `type: "module"` is what lets that event page `import`
 * (Firefox 112+, Safari 16.4+); without it `background.js` fails to load.
 *
 * `background.scripts` is deliberately absent from the CHROME manifest: Chrome
 * before 121 refuses to load an MV3 extension that declares it at all.
 */
const BACKGROUND_EVENT_PAGE = {
  scripts: ["src/background.js"],
  type: "module",
};

export const TARGETS = {
  firefox(manifest) {
    delete manifest.minimum_chrome_version;
    manifest.background = { ...BACKGROUND_EVENT_PAGE };
    // A stable id keeps storage.local (the learned composer fingerprint, the
    // gateway base) across reloads. strict_min_version 112 is where Firefox
    // started honouring `background.type: "module"` for event pages, without
    // which background.js cannot `import`.
    manifest.browser_specific_settings = {
      gecko: { id: GECKO_ID, strict_min_version: "112.0" },
    };
    return manifest;
  },
  safari(manifest) {
    delete manifest.minimum_chrome_version;
    // Event page only, and NOT also `service_worker`: Safari's MV3 background
    // service worker enforces CORS on extension fetches (Apple DTS thread
    // 654839), which would break the loopback call to the gateway. From a
    // background SCRIPT, Safari skips CORS for hosts in `host_permissions` —
    // which is how the gateway is reached. Declaring only `scripts` removes any
    // chance of Safari choosing the broken environment.
    manifest.background = { ...BACKGROUND_EVENT_PAGE };
    return manifest;
  },
};

/**
 * Copy `extension/src` plus a patched manifest into an output directory.
 * @param {string} target key of TARGETS
 * @param {{out?: string, patch?: (manifest: object) => object}} [opts]
 *   `patch` runs after the target's own patch — the Firefox test harness uses it
 *   to add its local page origin to the match patterns.
 * @returns {Promise<string>} the output directory
 */
export async function buildExtension(target, opts = {}) {
  const patch = TARGETS[target];
  if (!patch) throw new Error(`unknown target "${target}" (expected: ${Object.keys(TARGETS).join(", ")})`);
  let manifest = patch(JSON.parse(await readFile(join(EXT, "manifest.json"), "utf8")));
  if (opts.patch) manifest = opts.patch(manifest);
  const out = opts.out ?? join(BUILD, target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(join(EXT, "src"), join(out, "src"), { recursive: true });
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return out;
}

// Only act as a CLI when run directly, so the harness can import the helpers.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  for (const target of requested.length ? requested : Object.keys(TARGETS)) {
    console.log(`[build-extension] ${target} -> ${await buildExtension(target)}`);
  }
}
