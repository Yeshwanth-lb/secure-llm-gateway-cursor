// ===== GEMINI EXTENSION — GATEWAY CORS / PRIVATE-NETWORK-ACCESS REGRESSION ===
// The extension's background service worker fetches the loopback gateway
// (POST /redact, /log-turn). With a JSON content-type + a target of 127.0.0.1,
// newer Chrome sends a CORS **preflight** carrying Private Network Access:
//   OPTIONS ... Origin: chrome-extension://<id>
//                Access-Control-Request-Private-Network: true
// and then blocks the request unless the response echoes BOTH an
// `access-control-allow-origin` for that extension origin AND
// `access-control-allow-private-network: true`. The gateway used to grant CORS
// to LOOPBACK origins only and never sent the PNA header, so after a Chrome
// update the SW fetch failed → the extension saw "gateway unreachable" → every
// send was blocked and nothing logged (found live 2026-07-29).
//
// These are scoped to the HOOK endpoints only (/detect, /redact, /log-turn),
// which expose no stored traffic — the same trust boundary as the access gate.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../secure-llm-gateway.ts";

const EXT = "chrome-extension://ljahiogfolmgahghfokhnjcmlljogmbb";

let server: ReturnType<typeof createGatewayServer>;
let host: string;
let port: number;

before(async () => {
  server = createGatewayServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  host = "127.0.0.1";
});

after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

/** Raw HTTP so we can set forbidden headers (Origin) that fetch() would strip. */
function req(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host, port, method, path, headers }, (res) => {
      res.on("data", () => {}); // drain
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

// --- HAPPY: extension SW preflight + actual request both get the grants -------
test("happy: extension-origin preflight echoes ACAO + allow-private-network; POST carries ACAO", async () => {
  const pre = await req("OPTIONS", "/redact", {
    origin: EXT,
    "access-control-request-method": "POST",
    "access-control-request-private-network": "true",
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers["access-control-allow-origin"], EXT, "preflight must allow the extension origin");
  assert.equal(
    pre.headers["access-control-allow-private-network"],
    "true",
    "preflight must grant Private Network Access or newer Chrome blocks the loopback fetch",
  );

  // The ACTUAL response must ALSO carry ACAO, or the SW can't read the body.
  const post = await req(
    "POST",
    "/redact",
    { origin: EXT, "content-type": "application/json" },
    JSON.stringify({ text: "hi", audit: false }),
  );
  assert.equal(post.status, 200);
  assert.equal(post.headers["access-control-allow-origin"], EXT, "the redaction response must be readable by the SW");
});

// --- FAILURE: a foreign website origin still gets NO CORS grant ---------------
test("failure: a foreign http(s) origin receives no CORS on the hook endpoints", async () => {
  const pre = await req("OPTIONS", "/redact", {
    origin: "https://evil.example.com",
    "access-control-request-method": "POST",
    "access-control-request-private-network": "true",
  });
  assert.equal(pre.headers["access-control-allow-origin"], undefined, "foreign origin must not be allowed");
  assert.equal(pre.headers["access-control-allow-private-network"], undefined);

  const post = await req(
    "POST",
    "/redact",
    { origin: "https://evil.example.com", "content-type": "application/json" },
    JSON.stringify({ text: "hi", audit: false }),
  );
  assert.equal(post.headers["access-control-allow-origin"], undefined);
});

// --- EDGE: extension grant is scoped to hook paths; loopback keeps full CORS --
test("edge: extension origin is NOT granted on a non-hook path; loopback still is", async () => {
  // /logs is control-plane, not a hook endpoint — an extension origin must not
  // get a CORS grant there (it exposes stored traffic).
  const extOnLogs = await req("OPTIONS", "/logs", { origin: EXT });
  assert.equal(extOnLogs.headers["access-control-allow-origin"], undefined, "extension CORS is hook-only");

  // A loopback browser origin keeps full control-plane CORS on /redact.
  const loopback = await req("OPTIONS", "/redact", {
    origin: `http://127.0.0.1:${port}`,
    "access-control-request-method": "POST",
  });
  assert.equal(loopback.headers["access-control-allow-origin"], `http://127.0.0.1:${port}`);
});
