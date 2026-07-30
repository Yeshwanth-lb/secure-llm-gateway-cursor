// ===== BROWSER API SHIM (classic script AND importable) ====================
// Chrome/Edge expose only `chrome`. Firefox and Safari expose BOTH `browser`
// (promise-based) and `chrome` (Chrome-compatible, callback-based).
//
// This extension is written against the CALLBACK style, so the namespace is
// resolved `chrome` FIRST and `browser` only as a fallback — the reverse of the
// usual `browser ?? chrome` idiom. Preferring `browser` on Firefox would break
// every call site: Firefox's `browser.*` methods reject the extra callback
// argument ("Incorrect argument types") and `browser.runtime.onMessage` does not
// honour `return true` for a deferred `sendResponse`. Under `chrome.*` Firefox
// implements both, so the existing code runs unchanged.
//
// `storageGet` / `sendMessage` below still tolerate a promise-only namespace, so
// the extension also works on an engine that ships `browser` alone. That is the
// one place a shim is genuinely needed; everything else is namespace-identical.
//
// This file must stay a CLASSIC script (no `export`): `content-bridge.js` and
// `loader.js` are plain content scripts that cannot `import`, so the shim is
// listed ahead of them in `content_scripts.js` and publishes itself on
// `globalThis`. `background.js` is a module and gets the same object by
// importing this file for its side effect. Zero dependencies — deliberately not
// `webextension-polyfill`.

(function installBrowserApiShim() {
  const api = globalThis.chrome ?? globalThis.browser ?? null;

  /**
   * Invoke `fn` supporting BOTH extension API styles: Chrome-style (trailing
   * callback) and Firefox/Safari `browser.*`-style (returns a promise). Never
   * throws and never leaves a pending promise — resolves `undefined` on failure
   * so callers can fail closed.
   */
  function callEitherStyle(fn, thisArg, args) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        // Reading lastError marks a Chrome messaging error as handled; without
        // this Chrome logs "Unchecked runtime.lastError" for a dead worker.
        try {
          void (api && api.runtime && api.runtime.lastError);
        } catch {
          /* not a messaging call */
        }
        resolve(value);
      };
      const settleFrom = (ret) => {
        if (ret && typeof ret.then === "function") {
          ret.then(done, () => done(undefined));
          return true;
        }
        return false;
      };
      try {
        settleFrom(fn.apply(thisArg, [...args, done]));
      } catch {
        // Promise-only implementation: it rejected the callback argument.
        try {
          if (!settleFrom(fn.apply(thisArg, args))) done(undefined);
        } catch {
          done(undefined);
        }
      }
    });
  }

  /**
   * Read `keys` from a storage area. Resolves `{}` when the area is missing
   * (e.g. Safari has no `storage.managed`) or the read fails, so a caller can
   * merge the result unconditionally.
   * @param {object|null|undefined} area e.g. api.storage.local
   * @param {string[]} keys
   */
  function storageGet(area, keys) {
    if (!area || typeof area.get !== "function") return Promise.resolve({});
    return callEitherStyle(area.get, area, [keys]).then((v) => v || {});
  }

  /** Write `items` to a storage area. Best-effort; never throws. */
  function storageSet(area, items) {
    if (!area || typeof area.set !== "function") return Promise.resolve();
    return callEitherStyle(area.set, area, [items]).then(() => undefined);
  }

  /**
   * Send a message to the background. Resolves the background's reply, or
   * `undefined` when there is no receiver / the worker is dead — which the
   * callers treat as fail-closed.
   */
  function sendMessage(msg) {
    const rt = api && api.runtime;
    if (!rt || typeof rt.sendMessage !== "function") return Promise.resolve(undefined);
    return callEitherStyle(rt.sendMessage, rt, [msg]);
  }

  globalThis.geminiRedactBrowserApi = { api, storageGet, storageSet, sendMessage };
})();
