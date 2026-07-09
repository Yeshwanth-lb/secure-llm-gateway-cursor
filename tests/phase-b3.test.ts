// ===== PHASE B3 TESTS — MCP server (JSON-RPC over transports) =================
// Happy:   initialize -> tools/list -> tools/call get_traffic_logs over Streamable HTTP,
//          reading LIVE in-process traffic-log data.
// Failure: an unknown method returns JSON-RPC error -32601.
// Edge:    stdio transport keeps stdout protocol-pure (diagnostics on stderr).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createGatewayServer, trafficLog } from "../secure-llm-gateway.ts";
import type { LogEntry } from "../secure-llm-gateway.ts";
import { freePort } from "./helpers/net.ts";

let server: ReturnType<typeof createGatewayServer>;
let base: string;

before(async () => {
  server = createGatewayServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

const rpc = (base: string, msg: unknown) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg),
  });

// --- HAPPY: initialize -> tools/list -> tools/call over Streamable HTTP --------
test("happy: MCP handshake + tools/call get_traffic_logs reads live log data", async () => {
  // seed one entry so the tool has something real to return.
  trafficLog.clear();
  const seed: LogEntry = {
    id: "seed-1",
    timestamp: "2026-07-09T00:00:00.000Z",
    provider: "openai",
    method: "POST",
    path: "/openai/v1/chat/completions",
    status: 200,
    streaming: false,
    durationMs: 5,
    charCount: { request: 10, response: 20, total: 30 },
    payloadSnapshot: { request: "[REDACTED_PII_EMAIL]", response: "ok" },
    piiDetected: true,
    matchedRules: { inbound: { EMAIL: 1 }, outbound: {} },
  };
  trafficLog.push(seed);

  const init = await (await rpc(base, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  })).json();
  assert.equal(init.result.serverInfo.name, "secure-llm-gateway");
  assert.ok(init.result.capabilities.tools, "advertises tools capability");

  const list = await (await rpc(base, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  })).json();
  const names = (list.result.tools as { name: string }[]).map((t) => t.name);
  assert.ok(names.includes("get_traffic_logs"), "get_traffic_logs advertised");

  const call = await (await rpc(base, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_traffic_logs", arguments: { limit: 10 } },
  })).json();
  const text = call.result.content[0].text as string;
  const entries = JSON.parse(text) as LogEntry[];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "seed-1");
});

// --- FAILURE: unknown method -> -32601 ----------------------------------------
test("failure: unknown JSON-RPC method returns -32601", async () => {
  const res = await (await rpc(base, {
    jsonrpc: "2.0",
    id: 9,
    method: "does/not/exist",
  })).json();
  assert.equal(res.error.code, -32601);
  assert.equal(res.id, 9);
});

// --- EDGE: stdio transport keeps stdout protocol-pure -------------------------
test("edge: stdio mode emits only JSON-RPC on stdout (diagnostics on stderr)", async () => {
  const entry = fileURLToPath(new URL("../secure-llm-gateway.ts", import.meta.url));
  const port = await freePort(); // give the co-hosted HTTP server a free port
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", entry, "--stdio"],
    { env: { ...process.env, GATEWAY_PORT: String(port) }, stdio: ["pipe", "pipe", "pipe"] },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  // send an initialize request over stdin
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
  );

  // wait for a full stdout line (the JSON-RPC reply)
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for stdout")), 8000);
    const check = () => {
      const nl = stdout.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        resolve(stdout.slice(0, nl));
      }
    };
    child.stdout.on("data", check);
    check();
  });

  child.stdin.end();
  child.kill();

  // stdout's first line must parse cleanly as the JSON-RPC response — nothing else.
  const parsed = JSON.parse(line) as { id: number; result: { serverInfo: { name: string } } };
  assert.equal(parsed.id, 1);
  assert.equal(parsed.result.serverInfo.name, "secure-llm-gateway");
  // the "listening" diagnostic went to stderr, keeping stdout pure.
  assert.match(stderr, /listening/i);
  assert.doesNotMatch(stdout, /listening/i);
});
