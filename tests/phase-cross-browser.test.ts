// ===== CROSS-BROWSER PORT (Firefox + Safari) — headless tests ==============
// The DOM/extension behavior of the port is verified against a real Firefox by
// `npm run test:firefox-e2e` (browser-gated, like the Gemini e2e suites). What
// CAN be checked headlessly, and is easy to regress silently, is:
//
//   1. the API-namespace shim's RESOLUTION ORDER. `chrome` must win over
//      `browser`, because the whole extension is written in the callback style
//      and Firefox's `browser.*` rejects a trailing callback. Flipping this to
//      the more familiar `browser ?? chrome` would break every gateway call on
//      Firefox — and it would fail CLOSED, i.e. block every message, which is
//      safe but unusable.
//   2. the generated per-browser manifests. Firefox and Safari have no working
//      MV3 background service worker, so a missing `background.scripts` +
//      `type: "module"` means background.js never loads and nothing is redacted.
//
// Design ref: extension/CROSS_BROWSER_PORT.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TARGETS, buildExtension } from "../scripts/build-extension.mjs";

const SHIM = pathToFileURL(join(process.cwd(), "extension", "src", "browser-api.js")).href;
const CHROME_MANIFEST = join(process.cwd(), "extension", "manifest.json");

/**
 * Execute browser-api.js against a given set of globals and hand back what it
 * published. The shim is a classic script that assigns to `globalThis`, so it is
 * imported for its side effect with a cache-busting query — importing the same
 * URL twice would reuse the first evaluation.
 */
let evaluation = 0;
async function loadShim(globals: { chrome?: unknown; browser?: unknown }) {
  const saved = { chrome: globalThis.chrome, browser: (globalThis as any).browser };
  Object.assign(globalThis, { chrome: globals.chrome, browser: globals.browser });
  try {
    await import(`${SHIM}?case=${++evaluation}`);
    return (globalThis as any).geminiRedactBrowserApi;
  } finally {
    Object.assign(globalThis, saved);
    delete (globalThis as any).geminiRedactBrowserApi;
  }
}

/** A Chrome-style area: takes a trailing callback and returns undefined. */
const callbackArea = (value: object) => ({
  get(_keys: string[], cb: (v: object) => void) {
    cb(value);
  },
});

/** A Firefox `browser.*`-style area: returns a promise and REFUSES a callback. */
const promiseArea = (value: object) => ({
  get(_keys: string[], ...rest: unknown[]) {
    if (rest.length) throw new TypeError("Incorrect argument types for storage.get");
    return Promise.resolve(value);
  },
});

test("happy: the shim prefers callback-style `chrome` even when `browser` also exists", async () => {
  const chrome = { storage: { local: callbackArea({ base: "http://127.0.0.1:8001" }) }, runtime: {} };
  const browser = { storage: { local: promiseArea({ base: "wrong-namespace" }) }, runtime: {} };
  const shim = await loadShim({ chrome, browser });

  assert.equal(shim.api, chrome, "Firefox/Safari expose both; the callback-compatible one must win");
  assert.deepEqual(await shim.storageGet(shim.api.storage.local, ["base"]), {
    base: "http://127.0.0.1:8001",
  });
});

test("failure: a promise-only namespace still works, and absent messaging fails closed", async () => {
  // An engine that ships `browser` alone: every call site passes a callback, so
  // without the shim's retry each one would throw and the extension would be dead.
  const browser = {
    storage: { local: promiseArea({ base: "http://127.0.0.1:9999" }) },
    runtime: {
      sendMessage(_msg: unknown, ...rest: unknown[]) {
        if (rest.length) throw new TypeError("Incorrect argument types for runtime.sendMessage");
        return Promise.resolve({ ok: true, redacted: "[REDACTED_PII_EMAIL]" });
      },
    },
  };
  const shim = await loadShim({ chrome: undefined, browser });
  assert.equal(shim.api, browser);
  assert.deepEqual(await shim.storageGet(shim.api.storage.local, ["base"]), { base: "http://127.0.0.1:9999" });
  assert.deepEqual(await shim.sendMessage({ type: "redact", text: "x" }), {
    ok: true,
    redacted: "[REDACTED_PII_EMAIL]",
  });

  // No namespace at all -> sendMessage resolves undefined, which content-bridge
  // turns into { ok: false } so the send is BLOCKED rather than sent raw.
  const none = await loadShim({});
  assert.equal(none.api, null);
  assert.equal(await none.sendMessage({ type: "redact", text: "x" }), undefined);
});

test("edge: a missing storage area (Safari has no `managed`) resolves empty, and a throwing area does not reject", async () => {
  const chrome = {
    runtime: {},
    storage: {
      local: callbackArea({ enabled: true }),
      // managed intentionally absent
      broken: {
        get() {
          throw new Error("area unavailable");
        },
      },
    },
  };
  const shim = await loadShim({ chrome });
  assert.deepEqual(await shim.storageGet(shim.api.storage.managed, ["base"]), {});
  assert.deepEqual(await shim.storageGet(shim.api.storage.broken, ["base"]), {});
  assert.deepEqual(await shim.storageGet(shim.api.storage.local, ["enabled"]), { enabled: true });
});

test("happy: Firefox and Safari manifests get an ES-module event page; Chrome keeps its service worker", async () => {
  const chrome = JSON.parse(await readFile(CHROME_MANIFEST, "utf8"));
  assert.equal(chrome.background.service_worker, "src/background.js");
  assert.equal(chrome.background.scripts, undefined, "Chrome < 121 refuses an MV3 manifest declaring background.scripts");

  for (const target of ["firefox", "safari"] as const) {
    const m = TARGETS[target](JSON.parse(await readFile(CHROME_MANIFEST, "utf8")));
    assert.deepEqual(m.background.scripts, ["src/background.js"], `${target}: needs an event page`);
    assert.equal(m.background.type, "module", `${target}: background.js uses import`);
    assert.equal(m.background.service_worker, undefined, `${target}: must not offer the broken SW environment`);
    assert.equal(m.minimum_chrome_version, undefined, `${target}: Chrome-only key`);
    assert.equal(m.manifest_version, 3);
  }
});

test("failure: only the Firefox manifest carries gecko settings, and neither port widens access", async () => {
  const chrome = JSON.parse(await readFile(CHROME_MANIFEST, "utf8"));
  const firefox = TARGETS.firefox(JSON.parse(await readFile(CHROME_MANIFEST, "utf8")));
  const safari = TARGETS.safari(JSON.parse(await readFile(CHROME_MANIFEST, "utf8")));

  assert.match(firefox.browser_specific_settings.gecko.id, /@/, "a stable id keeps storage across reloads");
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, "112.0");
  assert.equal(safari.browser_specific_settings, undefined);

  // A port must not grant the extension more reach than Chrome has.
  for (const m of [firefox, safari]) {
    assert.deepEqual(m.host_permissions, chrome.host_permissions);
    assert.deepEqual(m.permissions, chrome.permissions);
    assert.deepEqual(m.content_scripts[0].matches, chrome.content_scripts[0].matches);
    assert.deepEqual(m.web_accessible_resources[0].matches, chrome.web_accessible_resources[0].matches);
    // MV3 object form, not the MV2 bare array.
    assert.ok(Array.isArray(m.web_accessible_resources[0].resources));
  }
});

test("edge: the shim is injected before the scripts that read it, and the packager emits a loadable tree", async () => {
  const chrome = JSON.parse(await readFile(CHROME_MANIFEST, "utf8"));
  // content-bridge.js and loader.js are classic content scripts that cannot
  // import, so they read the shim off globalThis — it MUST run first. Checked for
  // EVERY entry: adding a surface (ChatGPT) adds an entry, and one with the shim
  // out of order would break only that surface.
  for (const entry of chrome.content_scripts) {
    assert.deepEqual(entry.js, ["src/browser-api.js", "src/content-bridge.js", "src/loader.js"]);
  }

  const out = await mkdtemp(join(tmpdir(), "cross-browser-test-"));
  try {
    await buildExtension("firefox", { out });
    const built = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    assert.deepEqual(built.background.scripts, ["src/background.js"]);
    // Every file the manifest names must actually be in the package — across all
    // entries, so a resource only the ChatGPT entry lists still has to ship.
    for (const file of namedFiles(built)) {
      await readFile(join(out, file), "utf8"); // throws if the copy step missed it
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

/** Every packaged file a manifest refers to, across all entries. */
function namedFiles(manifest: any): string[] {
  return [
    ...manifest.content_scripts.flatMap((c: any) => c.js),
    ...manifest.web_accessible_resources.flatMap((w: any) => w.resources),
    ...(manifest.background.scripts ?? [manifest.background.service_worker]),
  ];
}

// A generated package under extension/build/<target> is what you actually load
// into Firefox/Safari, and NOTHING else regenerates it — so it silently rots the
// moment src/ or the Chrome manifest changes. That is not hypothetical: adding
// ChatGPT left a stale extension/build/firefox whose manifest didn't match
// chatgpt.com and which had no site-adapter.js, so the add-on never injected on
// that host at all. Because no content script ran there, neither the interceptor
// NOR the tripwire was present — the page was simply unprotected, which is the
// one failure mode this project treats as unacceptable (it is not fail-closed).
// The build dir is gitignored, so this only asserts "if you built it, it is
// current" and skips when nothing has been built.
test("failure: an out-of-date generated package is detected (stale build = unprotected surface)", async () => {
  let checked = 0;
  for (const target of Object.keys(TARGETS)) {
    const dir = join(process.cwd(), "extension", "build", target);
    const onDisk = await readFile(join(dir, "manifest.json"), "utf8").catch(() => null);
    if (onDisk === null) continue;
    checked++;

    const out = await mkdtemp(join(tmpdir(), `cross-browser-stale-${target}-`));
    try {
      await buildExtension(target, { out });
      const fresh = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
      assert.deepEqual(
        JSON.parse(onDisk),
        fresh,
        `extension/build/${target}/manifest.json is STALE — run: npm run ext:build:${target}`,
      );
      // The manifest can match while the copied sources are old (the stale build
      // was missing a whole module), so compare the packaged files too.
      for (const file of namedFiles(fresh)) {
        const [want, got] = await Promise.all([
          readFile(join(out, file), "utf8"),
          readFile(join(dir, file), "utf8").catch(() => null),
        ]);
        assert.equal(got, want, `extension/build/${target}/${file} is missing or STALE — run: npm run ext:build:${target}`);
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }
  console.log(`      (checked ${checked} generated package(s))`);
});
