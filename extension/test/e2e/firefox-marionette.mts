// ===== MINIMAL MARIONETTE CLIENT (zero dependencies) =======================
// The interceptor deliberately ignores events with `isTrusted === false`
// (interceptor-core.shouldIntercept — that IS the loop guard), so a keystroke
// dispatched from injected JS cannot be used to test the real submit path. Only
// genuine input works, which is what Marionette's WebDriver commands produce.
//
// Same `<len>:<json>` framing as the debugger protocol but a different envelope:
// commands are `[0, id, name, params]` and replies `[1, id, error, result]`.
// Firefox exposes it when launched with `--marionette`.

import net from "node:net";

/** The W3C WebDriver element-reference key. */
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
export const ENTER = "\uE007";

export type Marionette = {
  command(name: string, params?: Record<string, unknown>): Promise<any>;
  newSession(): Promise<void>;
  navigate(url: string): Promise<void>;
  findElement(css: string): Promise<string>;
  click(elementId: string): Promise<void>;
  sendKeys(elementId: string, text: string): Promise<void>;
  executeScript(script: string, args?: unknown[]): Promise<any>;
  close(): void;
};

export function connectMarionette(port = 2828, timeoutMs = 30000): Promise<Marionette> {
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
        let nextId = 1;
        const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
        sock.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          for (;;) {
            const sep = buf.indexOf(0x3a); // ":"
            if (sep < 0) return;
            const len = Number(buf.subarray(0, sep).toString("ascii"));
            if (!Number.isFinite(len) || buf.length < sep + 1 + len) return;
            const body = JSON.parse(buf.subarray(sep + 1, sep + 1 + len).toString("utf8"));
            buf = buf.subarray(sep + 1 + len);
            if (!Array.isArray(body)) continue; // the initial hello object
            const [, id, error, result] = body;
            const entry = pending.get(id);
            if (!entry) continue;
            pending.delete(id);
            if (error) entry.rej(new Error(`${error.error ?? "marionette"}: ${error.message ?? JSON.stringify(error)}`));
            else entry.res(result);
          }
        });

        const command = (name: string, params: Record<string, unknown> = {}) =>
          new Promise<any>((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            const json = Buffer.from(JSON.stringify([0, id, name, params]), "utf8");
            sock.write(`${json.length}:`);
            sock.write(json);
            setTimeout(() => {
              if (pending.delete(id)) rej(new Error(`marionette timeout: ${name}`));
            }, timeoutMs);
          });

        resolve({
          command,
          async newSession() {
            await command("WebDriver:NewSession", { capabilities: {} });
          },
          async navigate(url) {
            await command("WebDriver:Navigate", { url });
          },
          async findElement(css) {
            const r = await command("WebDriver:FindElement", { using: "css selector", value: css });
            const ref = r?.value ?? r;
            return ref[ELEMENT_KEY] ?? ref;
          },
          async click(elementId) {
            await command("WebDriver:ElementClick", { id: elementId });
          },
          async sendKeys(elementId, text) {
            await command("WebDriver:ElementSendKeys", { id: elementId, text });
          },
          async executeScript(script, args = []) {
            const r = await command("WebDriver:ExecuteScript", { script, args, newSandbox: false });
            return r?.value ?? r;
          },
          close: () => sock.destroy(),
        });
      });
    };
    attempt();
  });
}
