// ===== PHASE I — CROSS-PLATFORM SHARED-INSTANCE INTEGRATION ==================
// Core E2E trio (plan §7): happy / failure / edge concurrent start.
// Additional config + hook tests for local (loopback) Cursor/Claude wiring.
// Ephemeral ports + local fake upstream only; never contacts real providers and
// never mutates real user Claude/Cursor config (temp dirs).

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createGatewayServer, trafficLog } from "../secure-llm-gateway.ts";
import { startFakeUpstream } from "./helpers/fake-upstream.ts";
import { freePort } from "./helpers/net.ts";
import { PORT } from "../scripts/lib.mjs";

// Derive the expected loopback MCP URL from the same port source the service
// uses, so a default-port change can't silently break these assertions.
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE = path.join(REPO, "scripts", "gateway-service.mjs");
const HEALTH = path.join(REPO, "scripts", "health-check.mjs");
const CURSOR_HOOK = path.join(REPO, "scripts", "cursor-gateway-hook.mjs");

const rpc = (base: string, msg: unknown) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg),
  }).then((r) => r.json());

// --- HAPPY: both clients' traffic lands, redacted, in ONE shared log ----------
test("happy: Claude + Cursor/OpenAI traffic aggregate in one redacted log via MCP", async () => {
  const upstream = await startFakeUpstream();
  const server = createGatewayServer({
    upstreams: { openai: upstream.base, anthropic: upstream.base, gemini: upstream.base },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  trafficLog.clear();
  try {
    // Claude Code-shaped
    await fetch(`${base}/anthropic/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user", content: "claude reach a@corp.com" }] }),
    });
    // Cursor / OpenAI-shaped
    await fetch(`${base}/openai/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "cursor reach b@corp.com" }] }),
    });

    const call = await rpc(base, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "get_traffic_logs", arguments: { limit: 10 } },
    });
    const text = call.result.content[0].text as string;
    const entries = JSON.parse(text);
    const providers = entries.map((e: any) => e.provider).sort();
    assert.deepEqual(providers, ["anthropic", "openai"], "both clients in one shared log");
    assert.ok(entries.every((e: any) => e.matchedRules.inbound.EMAIL === 1), "both redacted");
    assert.doesNotMatch(text, /a@corp\.com|b@corp\.com/, "no raw PII in the MCP tool output");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await upstream.close();
  }
});

// --- FAILURE: health hook is fail-closed when the gateway is unavailable -------
test("failure: health-check hook exits non-zero against a dead gateway (no bypass)", async () => {
  const dead = await freePort(); // nothing listening
  const { code, stderr } = await runNode(HEALTH, {
    GATEWAY_PORT: String(dead),
    GATEWAY_ENV_BOOTSTRAPPED: "1",
  });
  assert.equal(code, 2, "hook fails closed (exit 2) so the session refuses to proceed");
  assert.match(stderr, /NOT reachable|refusing/i, "states unavailability, never claims readiness");
  assert.doesNotMatch(stderr, /a@corp\.com|api[_-]?key/i, "no secrets/PII in hook output");
});

test("config: configure-clients writes Cursor MCP + fail-closed session hooks only", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cfg-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "gw-state-"));
  const env = {
    CURSOR_CONFIG_DIR: tmp,
    CLAUDE_CONFIG_DIR: path.join(tmp, "claude"),
    GATEWAY_STATE_DIR: state,
    GATEWAY_ENV_BOOTSTRAPPED: "1",
  };
  try {
    const { code } = await runNode(SERVICE, env, "configure-clients");
    assert.equal(code, 0);
    const mcp = JSON.parse(fs.readFileSync(path.join(tmp, "mcp.json"), "utf8"));
    const hooks = JSON.parse(fs.readFileSync(path.join(tmp, "hooks.json"), "utf8"));
    assert.equal(mcp.mcpServers["secure-gateway"].type, "http");
    assert.equal(mcp.mcpServers["secure-gateway"].url, MCP_URL);
    assert.ok(hooks.hooks.sessionStart?.[0]?.failClosed, "sessionStart is fail-closed");
    assert.ok(hooks.hooks.beforeMCPExecution?.[0]?.failClosed, "beforeMCP is fail-closed");
    // preToolUse/postToolUse are the Phase L tool-data SCRUB hooks (rewrite),
    // not a per-tool health probe — they point at cursor-tool-redact-hook.
    assert.match(hooks.hooks.preToolUse?.[0]?.command ?? "", /cursor-tool-redact-hook\.mjs/);
    assert.match(hooks.hooks.postToolUse?.[0]?.command ?? "", /cursor-tool-redact-hook\.mjs/);
    assert.ok(hooks.hooks.preToolUse?.[0]?.failClosed, "preToolUse fail-closed");
    assert.match(hooks.hooks.sessionStart[0].command, /cursor-gateway-hook\.mjs/);
    assert.doesNotMatch(hooks.hooks.sessionStart[0].command, /^GATEWAY_PUBLIC_URL=/, "no shell env prefix");
    assert.equal(hooks.hooks.beforeMCPExecution?.[0]?.matcher, undefined, "filter in-script (user- prefix)");
    assert.ok(fs.existsSync(CURSOR_HOOK), "cursor hook script exists");

    const claude = JSON.parse(fs.readFileSync(path.join(tmp, "claude", "settings.json"), "utf8"));
    assert.match(claude.hooks.SessionStart?.[0]?.hooks?.[0]?.command ?? "", /claude-session-hook\.mjs/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});

// Regression: migrating from the old stdio bridge, configure-cursor must REPLACE
// our server entry with a fresh HTTP-only object, not deep-merge stale stdio keys
// (command/args/envFile) beside the new { type:"http", url }. Other servers kept.
test("config: configure-cursor replaces a stale stdio secure-gateway entry (no leftover keys)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cfg-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "gw-state-"));
  // Pre-seed a stdio-shaped entry + an unrelated server that must survive.
  fs.writeFileSync(path.join(tmp, "mcp.json"), JSON.stringify({
    mcpServers: {
      "secure-gateway": { command: "node", args: ["old-bridge.mjs"], envFile: "/tmp/.env" },
      "other-mcp": { type: "http", url: "http://127.0.0.1:9999/mcp" },
    },
  }));
  const env = {
    CURSOR_CONFIG_DIR: tmp,
    CLAUDE_CONFIG_DIR: path.join(tmp, "claude"),
    GATEWAY_STATE_DIR: state,
    GATEWAY_ENV_BOOTSTRAPPED: "1",
  };
  try {
    const { code } = await runNode(SERVICE, env, "configure-cursor");
    assert.equal(code, 0);
    const mcp = JSON.parse(fs.readFileSync(path.join(tmp, "mcp.json"), "utf8"));
    const entry = mcp.mcpServers["secure-gateway"];
    assert.equal(entry.type, "http");
    assert.equal(entry.url, MCP_URL);
    assert.equal(entry.command, undefined, "stale stdio command removed");
    assert.equal(entry.args, undefined, "stale stdio args removed");
    assert.equal(entry.envFile, undefined, "stale stdio envFile removed");
    assert.deepEqual(Object.keys(entry).sort(), ["type", "url"], "entry is HTTP-only");
    // Unrelated server preserved.
    assert.equal(mcp.mcpServers["other-mcp"]?.url, "http://127.0.0.1:9999/mcp");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});
// --- HOOK: beforeMCPExecution skips non-secure-gateway servers -----------------
test("hook: beforeMCPExecution allows non-secure-gateway MCP without health probe", async () => {
  const dead = await freePort();
  const { code, stdout } = await runNodeWithStdin(
    CURSOR_HOOK,
    { GATEWAY_PORT: String(dead) },
    JSON.stringify({ server: "some-other-mcp" }),
  );
  assert.equal(code, 0);
  const out = JSON.parse(stdout.trim());
  assert.equal(out.permission, "allow");
});

test("hook: beforeMCPExecution treats user-secure-gateway as ours", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "gw-hook-user-"));
  const installId = "test-cursor-user-prefix";
  fs.writeFileSync(path.join(state, "install-id"), installId + "\n");
  const upstream = await startFakeUpstream();
  const server = createGatewayServer({
    installId,
    upstreams: { openai: upstream.base, anthropic: upstream.base, gemini: upstream.base },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const { code, stdout } = await runNodeWithStdin(
      CURSOR_HOOK,
      {
        GATEWAY_PORT: String(port),
        GATEWAY_STATE_DIR: state,
        GATEWAY_ENV_BOOTSTRAPPED: "1",
      },
      JSON.stringify({ server: "user-secure-gateway" }),
    );
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout.trim()).permission, "allow");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await upstream.close();
    fs.rmSync(state, { recursive: true, force: true });
  }
});

// --- EDGE: concurrent start -> one listener + one identity + one combined log --
test("edge: concurrent start is idempotent — single instance, one shared log", async () => {
  const port = await freePort();
  const upstream = await startFakeUpstream();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-state-"));
  const env = {
    GATEWAY_PORT: String(port),
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_STATE_DIR: stateDir,
    GATEWAY_ENV_BOOTSTRAPPED: "1",
    ANTHROPIC_UPSTREAM: upstream.base,
    OPENAI_COMPAT_UPSTREAM: upstream.base,
    GEMINI_UPSTREAM: upstream.base,
  };
  const base = `http://127.0.0.1:${port}`;
  try {
    // fire two installers/starts concurrently at the same port
    const [a, b] = await Promise.all([runNode(SERVICE, env, "start"), runNode(SERVICE, env, "start")]);
    assert.ok(a.code === 0 || b.code === 0, "at least one start reports the gateway healthy");

    // one identity: two polls return the same installId (only one process bound)
    const h1 = await (await fetch(`${base}/healthz`)).json();
    const h2 = await (await fetch(`${base}/healthz`)).json();
    assert.equal(h1.status, "ok");
    assert.equal(h1.installId, h2.installId, "a single stable gateway identity");

    // concurrent Claude + Cursor requests -> single combined log
    await Promise.all([
      fetch(`${base}/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user", content: "x c@corp.com" }] }) }),
      fetch(`${base}/openai/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "y d@corp.com" }] }) }),
    ]);
    const logs = await (await fetch(`${base}/logs`)).json();
    const provs = logs.entries.map((e: any) => e.provider).sort();
    assert.ok(provs.includes("anthropic") && provs.includes("openai"), "both requests in one shared log");
    assert.doesNotMatch(JSON.stringify(logs), /c@corp\.com|d@corp\.com/, "log is redacted");
  } finally {
    await killPort(port);
    await upstream.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---- helpers ----------------------------------------------------------------

function runNode(script: string, extraEnv: Record<string, string>, ...args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath, [script, ...args],
      { env: { ...process.env, ...extraEnv }, timeout: 20000 },
      (err, stdout, stderr) => resolve({ code: err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0, stdout, stderr }),
    );
  });
}

function runNodeWithStdin(script: string, extraEnv: Record<string, string>, stdin: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function killPort(port: number) {
  return new Promise<void>((resolve) => {
    // Kill ONLY the listener (the detached gateway that won the bind) — never a
    // client connection to that port (that would include this test process).
    const p = spawn("bash", ["-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN -t | xargs kill 2>/dev/null || true`]);
    p.on("close", () => resolve());
    p.on("error", () => resolve());
  });
}
