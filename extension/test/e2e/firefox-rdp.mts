// ===== MINIMAL FIREFOX REMOTE-DEBUG CLIENT (zero dependencies) =============
// Playwright cannot load a browser extension into Firefox, and `web-ext` is an
// npm dependency this repo does not take. But `web-ext` only needs one thing
// from Firefox: the Remote Debugging Protocol's `installTemporaryAddon`. That is
// a length-prefixed JSON socket protocol (`<byteLength>:<json>`), so a few dozen
// lines of `node:net` replace the dependency and let the Firefox port be
// verified against a REAL Firefox instead of assumed.
//
// Only what the harness needs is implemented: connect, getRoot,
// installTemporaryAddon, and evaluating JS in a tab (used to read what the fake
// Gemini page recorded).

import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIREFOX_BIN = "/Applications/Firefox.app/Contents/MacOS/firefox";

/** Prefs that make a throwaway profile accept an RDP connection + a temp add-on. */
const USER_PREFS = [
  'user_pref("devtools.debugger.remote-enabled", true);',
  'user_pref("devtools.debugger.prompt-connection", false);',
  'user_pref("devtools.chrome.enabled", true);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.aboutwelcome.enabled", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("extensions.autoDisableScopes", 0);',
  // Firefox MV3 host permissions are opt-in; granting them up front is what the
  // user does in about:addons -> Permissions. Without this the background's
  // loopback fetch depends purely on the gateway's CORS grant.
  'user_pref("extensions.originControls.grantByDefault", true);',
].join("\n");

/** Extra prefs for the harness that also needs trusted input via Marionette. */
const marionettePrefs = (port: number) =>
  [`user_pref("marionette.port", ${port});`, 'user_pref("marionette.log.level", "Fatal");'].join("\n");

export type Rdp = {
  send(packet: Record<string, unknown>): Promise<any>;
  /** Resolve with the next unsolicited notification packet `match` accepts. */
  waitFor(match: (packet: any) => boolean, timeoutMs?: number): Promise<any>;
  close(): void;
};

/** Frame/deframe the `<len>:<json>` RDP wire format over a socket. */
function connectRdp(port: number, timeoutMs = 20000): Promise<Rdp> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("error", (err) => {
        if (Date.now() - started > timeoutMs) reject(err);
        else setTimeout(attempt, 250);
      });
      sock.once("connect", () => {
        let buf = Buffer.alloc(0);
        // The protocol has no request ids: replies arrive in order per actor, so
        // a FIFO of pending resolvers is sufficient for this scripted use. What
        // it must NOT do is consume NOTIFICATIONS — `evaluateJSAsync` acks
        // immediately and pushes the value later as its own packet. By RDP
        // convention a reply has no `type` field and a notification does, which
        // keeps the two streams apart.
        const pending: ((p: any) => void)[] = [];
        const watchers: { match: (p: any) => boolean; hit: (p: any) => void }[] = [];
        let greeted = false;
        sock.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          for (;;) {
            const sep = buf.indexOf(0x3a); // ":"
            if (sep < 0) return;
            const len = Number(buf.subarray(0, sep).toString("ascii"));
            if (!Number.isFinite(len) || buf.length < sep + 1 + len) return;
            const packet = JSON.parse(buf.subarray(sep + 1, sep + 1 + len).toString("utf8"));
            buf = buf.subarray(sep + 1 + len);
            if (!greeted) {
              greeted = true; // initial "root" hello is not a reply
              continue;
            }
            if (packet.type !== undefined) {
              for (let i = watchers.length - 1; i >= 0; i--) {
                if (watchers[i].match(packet)) watchers.splice(i, 1)[0].hit(packet);
              }
              continue;
            }
            const next = pending.shift();
            if (next) next(packet);
          }
        });
        resolve({
          send(packet) {
            return new Promise((res, rej) => {
              const json = Buffer.from(JSON.stringify(packet), "utf8");
              pending.push((reply) => (reply.error ? rej(new Error(`${reply.error}: ${reply.message ?? ""}`)) : res(reply)));
              sock.write(`${json.length}:`);
              sock.write(json);
              setTimeout(() => rej(new Error(`RDP timeout for ${JSON.stringify(packet).slice(0, 80)}`)), timeoutMs);
            });
          },
          waitFor(match, waitMs = timeoutMs) {
            return new Promise((res, rej) => {
              const entry = { match, hit: res };
              watchers.push(entry);
              setTimeout(() => {
                const i = watchers.indexOf(entry);
                if (i >= 0) {
                  watchers.splice(i, 1);
                  rej(new Error("RDP notification timeout"));
                }
              }, waitMs);
            });
          },
          close: () => sock.destroy(),
        });
      });
    };
    attempt();
  });
}

export type FirefoxSession = {
  rdp: Rdp;
  proc: ChildProcess;
  profile: string;
  /** Install an unpacked extension directory as a temporary add-on. */
  installAddon(dir: string): Promise<{ id: string }>;
  /** Evaluate an expression in the top window of the tab whose URL contains `urlPart`. */
  evalInTab(urlPart: string, expression: string): Promise<any>;
  /**
   * Evaluate an expression in the extension's BACKGROUND context. Used to seed
   * `storage.local` the way real config arrives, instead of patching defaults
   * into the test build.
   */
  /** Firefox's own view of the background event page + any manifest warnings. */
  backgroundStatus(addonId: string): Promise<{ status: string; warnings: string[] }>;
  /**
   * Navigate the tab matching `urlPart` to `url`. Content scripts only inject on
   * a page LOAD, so an add-on installed after the tab settled is not present on
   * that document — install first, then navigate here.
   */
  navigate(urlPart: string, url: string): Promise<void>;
  close(): void;
};

/**
 * Launch a real Firefox with a throwaway profile and an open RDP socket.
 * `headless` uses Firefox's own headless mode; the extension behaves the same,
 * and `headless:false` is available for eyeballing a live run.
 */
export async function launchFirefox(opts: {
  url: string;
  headless?: boolean;
  port?: number;
  marionettePort?: number;
}): Promise<FirefoxSession> {
  const profile = await mkdtemp(join(tmpdir(), "gemini-redact-ff-"));
  const prefs = [USER_PREFS, opts.marionettePort ? marionettePrefs(opts.marionettePort) : ""].join("\n");
  await writeFile(join(profile, "user.js"), `${prefs}\n`);
  const port = opts.port ?? 6000 + Math.floor(Math.random() * 2000);
  const args = [
    "--no-remote",
    "--new-instance",
    "--profile",
    profile,
    "--start-debugger-server",
    String(port),
    ...(opts.marionettePort ? ["--marionette"] : []),
    ...(opts.headless === false ? [] : ["--headless"]),
    opts.url,
  ];
  const proc = spawn(FIREFOX_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr?.on("data", () => {}); // Firefox is chatty on stderr; ignore
  const rdp = await connectRdp(port);

  /** Run an expression against a console actor and wait for the pushed result. */
  async function evaluate(consoleActor: string, expression: string) {
    const ack = await rdp.send({ to: consoleActor, type: "evaluateJSAsync", text: expression });
    const done = await rdp.waitFor((p) => p.type === "evaluationResult" && p.resultID === ack.resultID);
    if (done.exception) throw new Error(`eval threw: ${done.exceptionMessage ?? JSON.stringify(done.exception)}`);
    const value = done.result;
    // Primitives come through as-is; objects arrive as actor grips, so callers
    // stringify inside the target and read the primitive back.
    return value && typeof value === "object" ? (value.type === "undefined" ? undefined : value) : value;
  }

  async function tabFor(urlPart: string) {
    const { tabs } = await rdp.send({ to: "root", type: "listTabs" });
    const tab = (tabs || []).find((t: any) => String(t.url || "").includes(urlPart));
    if (!tab) throw new Error(`no tab matching "${urlPart}" (open: ${(tabs || []).map((t: any) => t.url).join(", ")})`);
    return tab;
  }

  return {
    rdp,
    proc,
    profile,
    async installAddon(dir: string) {
      const { addonsActor } = await rdp.send({ to: "root", type: "getRoot" });
      if (!addonsActor) throw new Error("Firefox did not expose an addonsActor over RDP");
      const reply = await rdp.send({ to: addonsActor, type: "installTemporaryAddon", addonPath: dir });
      return { id: reply?.addon?.id ?? reply?.id ?? "unknown" };
    },
    async navigate(urlPart: string, url: string) {
      // Driving it from inside the page is enough here and avoids depending on
      // which actor in the descriptor/target chain exposes `navigateTo` in a
      // given Firefox version. The reply may be lost to the navigation itself,
      // so a timeout is not an error.
      await this.evalInTab(urlPart, `location.href = ${JSON.stringify(url)}`).catch(() => {});
    },
    async evalInTab(urlPart: string, expression: string) {
      const tab = await tabFor(urlPart);
      const target = await rdp.send({ to: tab.actor, type: "getTarget" }).catch(() => null);
      const consoleActor = target?.frame?.consoleActor ?? tab.consoleActor;
      if (!consoleActor) throw new Error("no consoleActor for tab");
      return evaluate(consoleActor, expression);
    },
    async backgroundStatus(addonId: string) {
      const { addons } = await rdp.send({ to: "root", type: "listAddons" });
      const addon = (addons || []).find((a: any) => a.id === addonId);
      if (!addon) throw new Error(`add-on ${addonId} not listed`);
      return { status: addon.backgroundScriptStatus as string, warnings: (addon.warnings ?? []) as string[] };
    },
    close() {
      rdp.close();
      proc.kill("SIGKILL");
    },
  };
}
