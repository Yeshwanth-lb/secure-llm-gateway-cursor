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
import { loadConfig } from "./src/config.ts";
import { createGatewayServer } from "./src/server.ts";

// ---- public barrel ----------------------------------------------------------
export type {
  Provider,
  RouteResult,
  RedactionRule,
  Direction,
  RedactResult,
  CharCount,
  LogEntry,
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
} from "./src/redaction.ts";
export { StreamRedactor } from "./src/stream-redactor.ts";
export { resolveRoute } from "./src/routing.ts";
export { trafficLog } from "./src/traffic-log.ts";
export { createGatewayServer } from "./src/server.ts";

// ---- bootstrap --------------------------------------------------------------
function main(): void {
  const config = loadConfig();
  const server = createGatewayServer();
  server.listen(config.port, config.host, () => {
    process.stderr.write(
      `secure-llm-gateway listening on http://${config.host}:${config.port}\n`,
    );
  });
}

// Start only when executed directly, not when imported by the test runner.
const isEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntry) main();
