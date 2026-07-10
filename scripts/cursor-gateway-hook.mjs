#!/usr/bin/env node
// Cursor command hook: fail-closed gateway health gate for sessionStart and
// beforeMCPExecution (secure-gateway MCP only). Exits 0 when /healthz is
// healthy; exit 2 when not. Diagnostics on stderr only — never secrets/PII.
import path from "node:path";
import { health, BASE_URL, log, REPO_ROOT, MCP_SERVER_NAME } from "./lib.mjs";

const GATEWAY_SERVICE = path.join(REPO_ROOT, "scripts", "gateway-service.mjs");
const HEALTH_CACHE_MS = 5000;
let cachedAt = 0;
let lastHealth = null;

async function probeHealth() {
  const now = Date.now();
  if (lastHealth && now - cachedAt < HEALTH_CACHE_MS) return lastHealth;
  lastHealth = await health();
  cachedAt = lastHealth.ok ? now : 0;
  return lastHealth;
}

function hookServerName(ctx) {
  const raw =
    ctx.server ??
    ctx.serverName ??
    ctx.mcp_server ??
    ctx.mcpServer ??
    ctx.tool?.server ??
    ctx.tool?.mcpServer;
  return typeof raw === "string" ? raw : "";
}

// Drain stdin (Cursor sends hook context JSON); hang if we don't consume it.
let stdinJson = "";
await new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    stdinJson += c;
    if (stdinJson.length > 64 * 1024) process.stdin.destroy();
  });
  process.stdin.on("end", resolve);
  process.stdin.on("close", resolve);
  process.stdin.resume();
});

let ctx = {};
try {
  if (stdinJson.trim()) ctx = JSON.parse(stdinJson);
} catch { /* non-json hook context */ }

// beforeMCPExecution: only gate our MCP server — leave other MCP servers alone.
const server = hookServerName(ctx);
if (server && server !== MCP_SERVER_NAME) {
  process.stdout.write(JSON.stringify({ permission: "allow" }) + "\n");
  process.exit(0);
}

const h = await probeHealth();
if (h.ok) {
  log(`secure-llm-gateway: healthy at ${BASE_URL} (install ${h.installId ?? "?"})`);
  process.stdout.write(JSON.stringify({ permission: "allow" }) + "\n");
  process.exit(0);
}

const isRemote = BASE_URL.startsWith("https://");
log(`secure-llm-gateway: NOT reachable at ${BASE_URL} — refusing to proceed (fail-closed)`);
process.stdout.write(
  JSON.stringify({
    permission: "deny",
    user_message: isRemote
      ? `Secure LLM Gateway is not reachable at ${BASE_URL}. Check Render deploy and GATEWAY_MCP_TOKEN.`
      : `Secure LLM Gateway is not running at ${BASE_URL}. Start it with: node ${GATEWAY_SERVICE} start`,
    agent_message: "The PII gateway is down. Do not call upstream LLM APIs directly.",
  }) + "\n",
);
process.exit(2);
