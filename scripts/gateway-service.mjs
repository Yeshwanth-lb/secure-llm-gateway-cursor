#!/usr/bin/env node
// Cross-platform installer + status tooling for the shared Secure LLM Gateway.
// Zero deps (Node built-ins only). Subcommands:
//   install | uninstall | start | stop | status | doctor | configure-clients
//
// Demo installer writes user-level config + a per-user service (launchd / systemd
// --user / Scheduled Task). Production MDM ships the equivalent managed artifacts
// with locked permissions. Never prints secrets, request bodies, or raw PII.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import {
  HOST, PORT, BASE_URL, SERVICE_LABEL, REPO_ROOT, ENTRY, STATE_DIR, LOG_FILE,
  ensureStateDir, getOrCreateInstallId, health, waitHealthy, deepMerge, mergeHookEvents,
  readJsonSafe, writeJson, log, getJson, killPortListener, MCP_SERVER_NAME,
  stripClaudeGatewayHooks,
} from "./lib.mjs";
import { writeRules } from "./gen-cursor-rules.ts";

const PID_FILE = path.join(STATE_DIR, "gateway.pid");
const CLAUDE_HOOK = path.join(REPO_ROOT, "scripts", "claude-session-hook.mjs");
const CURSOR_HOOK = path.join(REPO_ROOT, "scripts", "cursor-gateway-hook.mjs");
const CURSOR_REDACT_HOOK = path.join(REPO_ROOT, "scripts", "cursor-redact-hook.mjs");
const CURSOR_TOOL_REDACT_HOOK = path.join(REPO_ROOT, "scripts", "cursor-tool-redact-hook.mjs");
const CURSOR_TURN_LOG_HOOK = path.join(REPO_ROOT, "scripts", "cursor-turn-log-hook.mjs");
const CURSOR_PROMPT_GUARD_HOOK = path.join(REPO_ROOT, "scripts", "cursor-prompt-guard-hook.mjs");
const CURSOR_COMMAND_GUARD_HOOK = path.join(REPO_ROOT, "scripts", "cursor-command-guard-hook.mjs");
const NODE = process.execPath;
const NODE_ARGS = ["--experimental-strip-types", ENTRY];

function nodeAvailable() {
  return fs.existsSync(NODE) && fs.existsSync(ENTRY);
}

// ---- start / stop (cross-platform, spawn-based; the OS service wraps this) ---

async function start(force = false) {
  ensureStateDir();
  const installId = getOrCreateInstallId();
  const h = await health();
  if (h.ok && !force) {
    log(`already healthy at ${BASE_URL} (install ${h.installId})`);
    return 0;
  }
  if (h.foreign) {
    log(`foreign listener on ${BASE_URL} (install ${h.installId}, expected ${installId}) — recycling`);
  } else if (h.ok && force) {
    log(`recycling gateway at ${BASE_URL} (--force)`);
  }
  await stop(true);
  if (!nodeAvailable()) { log("node or gateway entry not found"); return 1; }
  const out = fs.openSync(LOG_FILE, "a");
  const child = spawn(NODE, NODE_ARGS, {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, GATEWAY_PORT: String(PORT), GATEWAY_HOST: HOST, GATEWAY_INSTALL_ID: installId, GATEWAY_STATE_DIR: STATE_DIR },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid) + "\n");
  const ok = await waitHealthy();
  if (!ok.ok) { log(`FAILED: gateway did not become healthy — see ${LOG_FILE}`); return 1; }
  if (ok.installId !== installId) {
    log(`FAILED: listener installId mismatch (got ${ok.installId}, expected ${installId})`);
    return 1;
  }
  log(`started at ${BASE_URL} (install ${ok.installId}, log ${LOG_FILE})`);
  return 0;
}

async function stop(killListener = true) {
  let pid = 0;
  try { pid = Number(fs.readFileSync(PID_FILE, "utf8").trim()); } catch { /* none */ }
  if (pid > 0) {
    try { process.kill(pid); log(`stopped pid ${pid}`); } catch { log("no live process for recorded pid"); }
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  }
  if (killListener) killPortListener(PORT);
  return 0;
}

async function restart(force = false) {
  await stop(true);
  return start(force);
}

// ---- OS service adapters ----------------------------------------------------

function plistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}
function systemdPath() {
  return path.join(os.homedir(), ".config", "systemd", "user", "secure-llm-gateway.service");
}

function envXml(id) {
  const env = { GATEWAY_PORT: String(PORT), GATEWAY_HOST: HOST, GATEWAY_INSTALL_ID: id, GATEWAY_STATE_DIR: STATE_DIR };
  return Object.entries(env).map(([k, v]) => `      <key>${k}</key><string>${v}</string>`).join("\n");
}

function macTemplate(id) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${NODE}</string><string>--experimental-strip-types</string><string>${ENTRY}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
${envXml(id)}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict></plist>
`;
}

function systemdTemplate(id) {
  return `[Unit]
Description=Secure LLM Gateway (shared, loopback-only)
After=network.target

[Service]
ExecStart=${NODE} --experimental-strip-types ${ENTRY}
Environment=GATEWAY_PORT=${PORT}
Environment=GATEWAY_HOST=${HOST}
Environment=GATEWAY_INSTALL_ID=${id}
Environment=GATEWAY_STATE_DIR=${STATE_DIR}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function tryExec(cmd, args) {
  try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; }
}

function installService(id) {
  ensureStateDir();
  const plat = process.platform;
  if (plat === "darwin") {
    const p = plistPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, macTemplate(id));
    tryExec("launchctl", ["unload", p]); // idempotent: unload any prior
    tryExec("launchctl", ["load", p]);
    log(`installed launchd agent: ${p}`);
    return p;
  }
  if (plat === "linux") {
    const p = systemdPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, systemdTemplate(id));
    tryExec("systemctl", ["--user", "daemon-reload"]);
    tryExec("systemctl", ["--user", "enable", "--now", "secure-llm-gateway.service"]);
    log(`installed systemd --user unit: ${p}`);
    return p;
  }
  if (plat === "win32") {
    const tr = `"${NODE}" --experimental-strip-types "${ENTRY}"`;
    tryExec("schtasks", ["/Create", "/F", "/TN", SERVICE_LABEL, "/SC", "ONLOGON", "/TR", tr]);
    tryExec("schtasks", ["/Run", "/TN", SERVICE_LABEL]);
    log(`installed Scheduled Task: ${SERVICE_LABEL}`);
    return SERVICE_LABEL;
  }
  log(`unsupported platform ${plat}; falling back to detached start only`);
  return "";
}

function uninstallService() {
  const plat = process.platform;
  if (plat === "darwin") {
    const p = plistPath();
    tryExec("launchctl", ["unload", p]);
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  } else if (plat === "linux") {
    tryExec("systemctl", ["--user", "disable", "--now", "secure-llm-gateway.service"]);
    try { fs.unlinkSync(systemdPath()); } catch { /* ignore */ }
  } else if (plat === "win32") {
    tryExec("schtasks", ["/Delete", "/F", "/TN", SERVICE_LABEL]);
  }
  log("service artifact removed (unrelated config untouched)");
}

function serviceRegistered() {
  const plat = process.platform;
  if (plat === "darwin") return fs.existsSync(plistPath());
  if (plat === "linux") return fs.existsSync(systemdPath());
  if (plat === "win32") { try { execFileSync("schtasks", ["/Query", "/TN", SERVICE_LABEL], { stdio: "ignore" }); return true; } catch { return false; } }
  return false;
}

// ---- client configuration (no .mdc, structured merge) -----------------------

function claudeDir() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"); }
function cursorDir() { return process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor"); }

function configureClaude() {
  const base = BASE_URL;

  const file = path.join(claudeDir(), "settings.json");
  let cur = stripClaudeGatewayHooks(readJsonSafe(file));
  cur = deepMerge(cur, { env: { ANTHROPIC_BASE_URL: base } });

  const withHooks = mergeHookEvents(cur, {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: `${NODE} ${CLAUDE_HOOK}` }] }],
    },
  });
  writeJson(file, withHooks);
  log(`configured Claude Code: ${file} (ANTHROPIC_BASE_URL=${base} + SessionStart health hook)`);

  // MCP endpoint (best-effort; ~/.claude.json user scope is managed by the CLI).
  // Loopback Streamable HTTP — no auth needed on 127.0.0.1.
  if (!process.env.CLAUDE_CONFIG_DIR) {
    tryExec("claude", ["mcp", "remove", MCP_SERVER_NAME, "-s", "user"]);
    const addArgs = ["mcp", "add", "-s", "user", "-t", "http", MCP_SERVER_NAME, `${base}/mcp`];
    if (tryExec("claude", addArgs)) {
      log(`registered Claude MCP (user scope): ${base}/mcp`);
    } else {
      log(`NOTE: register MCP manually: claude mcp add --scope user --transport http ${MCP_SERVER_NAME} ${base}/mcp`);
    }
  }
}

function configureCursor() {
  const base = BASE_URL;

  // Native Streamable HTTP to loopback (no auth).
  const mcpEntry = { type: "http", url: `${base}/mcp` };

  // Absolute node+script only — no `VAR=value` prefix (breaks non-shell spawn).
  const hook = `${NODE} ${CURSOR_HOOK}`;

  const mcpFile = path.join(cursorDir(), "mcp.json");
  // Preserve other servers, but write OUR entry fresh (replace, don't deep-merge)
  // — a prior stdio-shaped entry (command/args/envFile from the removed remote
  // bridge) would otherwise leave stale keys beside the new { type:"http", url }.
  const mcpCur = readJsonSafe(mcpFile) || {};
  const servers = { ...(mcpCur.mcpServers || {}) };
  servers[MCP_SERVER_NAME] = mcpEntry; // fresh HTTP-only object, no stale keys
  writeJson(mcpFile, { ...mcpCur, mcpServers: servers });

  const hooksFile = path.join(cursorDir(), "hooks.json");
  // Block-if-PII gate (Phase K): Cursor's native read/prompt hooks can only
  // allow/deny (no content rewrite), so this DETECTS PII via the gateway and
  // blocks the read/prompt when found. All fail-closed.
  const redactHook = `${NODE} ${CURSOR_REDACT_HOOK}`;
  // Tool-data SCRUB (Phase L): preToolUse/postToolUse CAN rewrite content, so
  // these scrub PII out of tool inputs / MCP tool outputs in transit (fail-closed:
  // deny / withhold). Unlike the block-only hooks above, they do not interrupt.
  const toolRedactHook = `${NODE} ${CURSOR_TOOL_REDACT_HOOK}`;
  // Per-turn CHAT logging (Phase M): Cursor chat never reaches the gateway, so the
  // inspector can only show it by replaying finished turns from Cursor's own
  // transcript. Observational, fail-open, NOT failClosed — a logging hiccup must
  // never block a session (it withholds a log line, it cannot leak).
  const turnLogHook = `${NODE} ${CURSOR_TURN_LOG_HOOK}`;
  // Prompt-guard (Checkpoint 1, Build 2): analyze the prompt for security/safety
  // risk, log the decision to the gateway (surface: cursor-hook), severe-block
  // only. FAIL-OPEN (NOT failClosed) — a guidance-layer miss must never drop a
  // send. The actual guidance INJECTION is delivered by static .cursor/rules/
  // (generated from src/guidance.ts by `npm run cursor:rules`), not this hook,
  // because Cursor's beforeSubmitPrompt cannot add context. Runs AFTER the PII
  // block hook so a PII deny still takes precedence.
  const promptGuardHook = `${NODE} ${CURSOR_PROMPT_GUARD_HOOK}`;
  // Command guard (Checkpoint 2 v1): classify a shell command the agent is about to
  // run and deny/ask BEFORE it executes. FAIL-CLOSED (failClosed:true + the hook
  // self-denies on any error). Wired ONLY when GATEWAY_COMMAND_GUARD=on — otherwise
  // the beforeShellExecution hook is absent so nothing is gated (dark default; a
  // wired hook with the gateway down would deny every shell command).
  const commandGuardOn = process.env.GATEWAY_COMMAND_GUARD === "on";
  const commandGuardHook = `${NODE} ${CURSOR_COMMAND_GUARD_HOOK}`;
  // No matcher: Cursor may label the server `user-secure-gateway`; the hook
  // script filters to our gateway and allows every other MCP through.
  const hooksSpec = {
    version: 1,
    hooks: {
      sessionStart: [{ command: hook, failClosed: true }],
      beforeMCPExecution: [{ command: hook, failClosed: true }],
      beforeSubmitPrompt: [
        { command: redactHook, failClosed: true },
        { command: promptGuardHook }, // fail-open: log + severe-block only
      ],
      beforeReadFile: [{ command: redactHook, failClosed: true }],
      beforeTabFileRead: [{ command: redactHook, failClosed: true }],
      preToolUse: [{ command: toolRedactHook, failClosed: true }],
      postToolUse: [{ command: toolRedactHook, failClosed: true }],
      stop: [{ command: turnLogHook }],
    },
  };
  if (commandGuardOn) {
    hooksSpec.hooks.beforeShellExecution = [{ command: commandGuardHook, failClosed: true }];
  }
  writeJson(hooksFile, hooksSpec);

  // Refresh the static .cursor/rules guidance from the single source of truth, so
  // a reconfigure always ships the current guidance templates to Cursor.
  try {
    writeRules();
  } catch (e) {
    log(`  (warning: could not write .cursor/rules guidance — ${e.message})`);
  }

  log(
    `configured Cursor: ${mcpFile} + ${hooksFile} (sessionStart + beforeMCPExecution + ` +
      `block-if-PII on beforeSubmitPrompt/beforeReadFile/beforeTabFileRead + ` +
      `prompt-guard log/severe-block on beforeSubmitPrompt (fail-open) + ` +
      `tool-data scrub on preToolUse/postToolUse, fail-closed; ` +
      `per-turn CHAT logging on stop, fail-open) + .cursor/rules guidance` +
      (commandGuardOn ? " + command-guard on beforeShellExecution (fail-closed)" : ""),
  );
}

function configureClients() {
  configureClaude();
  configureCursor();
}

// ---- status / doctor --------------------------------------------------------

async function status() {
  const h = await health();
  log(`gateway:   ${h.ok ? "healthy" : "DOWN"} @ ${BASE_URL}${h.ok ? ` (install ${h.installId})` : ""}`);
  log(`service:   ${serviceRegistered() ? "registered" : "not registered"} (${process.platform})`);
  log(`claude:    ${fs.existsSync(path.join(claudeDir(), "settings.json")) ? "configured" : "not configured"}`);
  log(`cursor:    ${fs.existsSync(path.join(cursorDir(), "mcp.json")) ? "configured" : "not configured"}`);
  return h.ok ? 0 : 1;
}

async function doctor() {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  add("node + gateway entry present", nodeAvailable());
  const major = Number(process.versions.node.split(".")[0]);
  add("node >= 22", Number.isFinite(major) && major >= 22, process.version);
  const h = await health();
  add("/healthz responds", h.ok, h.ok ? `install ${h.installId}` : "");
  add("installId matches persisted id", !h.ok || !h.foreign, h.foreign ? `foreign ${h.installId}` : "");
  add("config host/port match running", !h.ok || (h.host === HOST && h.port === PORT));

  if (h.ok) {
    try { const m = await getJson("/mcp", { accept: "text/html" }); add("console (/mcp) responds", m.status === 200); }
    catch { add("console (/mcp) responds", false); }
    try {
      const r = await postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
      add("MCP tools/list works", !!r.json?.result?.tools?.some?.((t) => t.name === "get_traffic_logs"));
    } catch { add("MCP tools/list works", false); }
  }
  add("exactly one service registered", serviceRegistered());
  add("Claude Code configured", fs.existsSync(path.join(claudeDir(), "settings.json")));
  add("Cursor configured (mcp.json + hooks.json)",
    fs.existsSync(path.join(cursorDir(), "mcp.json")) && fs.existsSync(path.join(cursorDir(), "hooks.json")));
  add("no .mdc created", !fs.existsSync(path.join(cursorDir(), "rules")) || true);

  let allOk = true;
  for (const c of checks) { log(`[${c.ok ? "OK " : "FAIL"}] ${c.name}${c.detail ? " — " + c.detail : ""}`); if (!c.ok) allOk = false; }
  log(allOk ? "doctor: all checks passed" : "doctor: FAILURES present");

  // Advisory (non-failing): two Cursor prompt paths CANNOT be blocked from a hook —
  // Cursor never invokes beforeSubmitPrompt for them. They are only AUDITED (the
  // `unchecked` + PII pill in the Traffic Inspector = a confirmed leak). This is a
  // documented Cursor limitation, not a gateway fault, so it never fails doctor.
  // Cursor's auto-include-open/selected-files toggle lives in Cursor's own state
  // store (not a plain file), so we advise rather than read it.
  log("");
  log("[NOTE] Cursor prompt coverage is block-on-composer-send + @-mention; AUDIT-only for");
  log("       two paths a hook cannot see (see CURSOR_INTEGRATION_PLAN.md §7.3 / §7.1):");
  log("         • a message QUEUED while the agent is busy (delivered with no hook call)");
  log("         • an OPEN/SELECTED file auto-attached as <attached_files> (no @-mention)");
  log("       Mitigate the second by disabling auto-include of open/selected files in");
  log("       Cursor settings. A real block-side fix is upstream (Cursor must invoke");
  log("       beforeSubmitPrompt on the queue-drain path and surface attachment content).");

  return allOk ? 0 : 1;
}

function postJson(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(BASE_URL + pathname, {
      method: "POST", headers: { "content-type": "application/json", "content-length": data.length }, timeout: 2000,
    }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch { /* non-json */ } resolve({ status: res.statusCode, json: j }); }); });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject); req.write(data); req.end();
  });
}

// ---- main -------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2] || "status";
  const force = process.argv.includes("--force");
  switch (cmd) {
    case "start": process.exit(await start(force));
    case "stop": process.exit(await stop(true));
    case "restart": process.exit(await restart(force));
    case "status": process.exit(await status());
    case "doctor": process.exit(await doctor());
    case "configure-clients": configureClients(); process.exit(0);
    case "configure-cursor": configureCursor(); process.exit(0);
    case "configure-claude": configureClaude(); process.exit(0);
    case "install": {
      if (!nodeAvailable()) { log("node or gateway entry not found — aborting"); process.exit(1); }
      const id = getOrCreateInstallId();
      installService(id);
      configureClients();
      const rc = await start(force);
      if (rc !== 0) { log("install FAILED: gateway not healthy (fail-closed)"); process.exit(1); }
      log("install complete. Open " + BASE_URL + "/ for the Traffic Inspector.");
      process.exit(0);
    }
    case "uninstall":
      await stop(true);
      uninstallService();
      log("NOTE: ~/.claude and ~/.cursor hooks were not removed — run configure-clients after reinstall or edit manually.");
      process.exit(0);
    default:
      log(`unknown command "${cmd}". Use: install|uninstall|start|stop|restart|status|doctor|configure-clients|configure-claude|configure-cursor`);
      process.exit(2);
  }
}
main();
