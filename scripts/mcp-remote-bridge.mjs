#!/usr/bin/env node
// Stdio MCP bridge for Cursor/Claude — reads token from ~/.secure-llm-gateway/.env
// and forwards JSON-RPC to remote Streamable HTTP /mcp. Avoids ${env:…} in mcp.json
// (GUI apps on macOS do not inherit shell profile).
import readline from "node:readline";
import https from "node:https";
import http from "node:http";
import { BASE_URL, ENV_FILE, log, MCP_SERVER_NAME } from "./lib.mjs";

const token = process.env.GATEWAY_MCP_TOKEN || "";
if (!token) {
  log(`${MCP_SERVER_NAME}: GATEWAY_MCP_TOKEN missing — run: node scripts/gateway-service.mjs init-env --token TOKEN --remote-url URL`);
  log(`  expected env file: ${ENV_FILE}`);
  process.exit(1);
}
if (!BASE_URL.startsWith("https://") && !BASE_URL.startsWith("http://127.0.0.1")) {
  log(`${MCP_SERVER_NAME}: remote bridge requires GATEWAY_PUBLIC_URL (https://…) in ${ENV_FILE}`);
  process.exit(1);
}

const target = new URL("/mcp", BASE_URL.endsWith("/") ? BASE_URL : BASE_URL + "/");
const lib = target.protocol === "https:" ? https : http;

function postRpc(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req = lib.request(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(data.length),
          "x-gateway-token": token,
        },
        timeout: 60_000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode === 401) {
            reject(new Error("Unauthorized — check GATEWAY_MCP_TOKEN matches Render GATEWAY_ADMIN_TOKEN"));
            return;
          }
          if (res.statusCode !== 200 && res.statusCode !== 202) {
            reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
            return;
          }
          if (!buf.trim()) {
            resolve(null);
            return;
          }
          resolve(buf);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const t = line.trim();
  if (t === "") return;
  try {
    const out = await postRpc(t);
    if (out) process.stdout.write(out.trim() + "\n");
  } catch (err) {
    log(`${MCP_SERVER_NAME} bridge error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
});
