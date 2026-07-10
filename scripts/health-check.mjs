#!/usr/bin/env node
// Fail-closed health probe for managed hooks (Claude Code SessionStart, Cursor
// sessionStart/beforeMCPExecution). Exits 0 only when the shared gateway is
// healthy; exits non-zero otherwise so a session/tool can refuse to proceed
// rather than silently bypassing the proxy. Prints only safe status — no
// secrets, no request bodies, no PII.
import { health, BASE_URL, log } from "./lib.mjs";

const h = await health();
if (h.ok) {
  log(`secure-llm-gateway: healthy at ${BASE_URL} (install ${h.installId ?? "?"})`);
  process.exit(0);
}
log(`secure-llm-gateway: NOT reachable at ${BASE_URL} — refusing to proceed (fail-closed)`);
if (BASE_URL.startsWith("https://")) {
  log("Remote gateway: check Render deploy, cold start, and GATEWAY_MCP_TOKEN for MCP.");
}
// Exit 2 so Cursor hooks with failClosed treat this as an explicit deny (not fail-open).
process.exit(2);
