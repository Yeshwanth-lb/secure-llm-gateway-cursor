#!/usr/bin/env node
// =============================================================================
// secure-llm-gateway.ts — entry point + public barrel.
// -----------------------------------------------------------------------------
// The gateway is now a small module graph under src/ (Node >= 22 built-ins only,
// zero runtime deps). This file re-exports the public surface so consumers and
// tests import from one place, and boots the HTTP server when run directly.
//
// Run:   node --experimental-strip-types secure-llm-gateway.ts
// stdio: node --experimental-strip-types secure-llm-gateway.ts --stdio
//
// Design authority: newplan.md > PRD.md > IMPLEMENTATION_GUIDE.md. Module layout
// and per-phase progress are tracked in CLAUDE.md §8.
// =============================================================================

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "./src/config.ts";
import { createGatewayServer } from "./src/server.ts";
import { startStdioTransport } from "./src/mcp.ts";

// ---- public barrel ----------------------------------------------------------
export type {
  Provider,
  RouteResult,
  RedactionRule,
  Direction,
  RedactResult,
  CharCount,
  LogEntry,
  RiskCategory,
  CategoryAction,
  AnalyzerVerdict,
  AnalyzerResult,
  AnalyzerLog,
} from "./src/contracts.ts";
export type { GatewayConfig } from "./src/config.ts";
export { loadConfig } from "./src/config.ts";
export {
  DEFAULT_RULES,
  getRuleSources,
  getActiveRuleInfo,
  resetRedactionRules,
  redactText,
  redactJson,
  isAllowlisted,
  listRules,
  setRuleEnabled,
  addCustomRule,
  removeRule,
  listAllowlist,
  addAllowlistEntry,
  setAllowlistEnabled,
  removeAllowlistEntry,
} from "./src/redaction.ts";
export { StreamRedactor } from "./src/stream-redactor.ts";
export {
  openaiToAnthropicRequest,
  anthropicToOpenAIResponse,
  AnthropicToOpenAISSE,
  resolveModel,
  shouldTranslate,
} from "./src/openai-anthropic-shim.ts";
export { resolveRoute, buildForwardHeaders } from "./src/routing.ts";
export { trafficLog } from "./src/traffic-log.ts";
export { securityLog } from "./src/security-log.ts";
export type { SecurityLogEntry } from "./src/security-log.ts";
export {
  analyze,
  tier1IsTrivial,
  setPromptClassifier,
  resetPromptClassifier,
  type ClassifyFn,
  type ClassifierVerdict,
} from "./src/prompt-analyzer.ts";
export { classifyViaAnthropic, parseClassifierJson } from "./src/prompt-classifier.ts";
export {
  GUIDANCE,
  GUIDANCE_PREFIX,
  buildGuidance,
  templateIdsFor,
  hasBlockCategory,
} from "./src/guidance.ts";
export { classifyCommand, COMMAND_CATEGORIES } from "./src/command-rules.ts";
export type { CommandVerdict, CommandCategory, CommandPermission } from "./src/command-rules.ts";
export { proxyRequest } from "./src/proxy.ts";
export { dispatch, handleMcpHttp, isMcpPath } from "./src/mcp.ts";
export { createGatewayServer } from "./src/server.ts";
export { INSPECTOR_HTML } from "./src/inspector.ts";
export { CONSOLE_HTML } from "./src/console.ts";
export { handleControlApi, isApiPath } from "./src/control-api.ts";
export { isAdminPath, handleAdminApi } from "./src/admin-api.ts";
export { openAdminStore, surfaceOf, modesForSurface, SURFACES } from "./src/admin-store.ts";
export { hashPassword, verifyPassword, signJWT, verifyJWT, resetLoginRate } from "./src/admin-auth.ts";
export { ADMIN_HTML } from "./src/admin-console.ts";
export { cleanEntry, extractUserPrompt, extractAssistantOutput } from "./src/clean-view.ts";
export {
  listModelPolicies,
  setModelBlocked,
  resetModelPolicies,
  isModelBlocked,
  extractModel,
} from "./src/model-policy.ts";

// ---- bootstrap --------------------------------------------------------------
// Load STATE_DIR/.env (default ~/.secure-llm-gateway/.env) into process.env
// before config. This is where the server-side ANTHROPIC_API_KEY lives (used by
// the Cursor translate auth-swap). Zero-dep KEY=VALUE parse; existing env wins,
// so launchd/CLI overrides are never clobbered. Missing file is a no-op.
function loadStateEnv(): void {
  const dir = process.env.GATEWAY_STATE_DIR || path.join(os.homedir(), ".secure-llm-gateway");
  const file = path.join(dir, ".env");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env -> nothing to load
  }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

function main(): void {
  loadStateEnv();
  const config = loadConfig();
  const stdio = process.argv.includes("--stdio") || process.env.MCP_STDIO === "1";
  if (stdio) startStdioTransport(); // stdout stays JSON-RPC only; logs go to stderr

  const server = createGatewayServer();
  server.on("error", (err: NodeJS.ErrnoException) => {
    // A busy port must never take down the process — especially in stdio mode,
    // where the MCP transport on stdin/stdout is independent of the HTTP server.
    process.stderr.write(
      `secure-llm-gateway: HTTP listen failed on ${config.host}:${config.port} (${err.code ?? err.message}).\n`,
    );
    if (!stdio) process.exit(1); // no stdio fallback -> nothing to do, exit cleanly
    process.stderr.write("Continuing in stdio-only mode (HTTP proxy + /logs unavailable).\n");
  });
  server.listen(config.port, config.host, () => {
    process.stderr.write(
      `secure-llm-gateway listening on http://${config.host}:${config.port}\n`,
    );
  });
}

// Start only when executed directly, not when imported by the test runner.
const isEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntry) main();
