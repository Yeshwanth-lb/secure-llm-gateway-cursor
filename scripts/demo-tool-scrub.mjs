#!/usr/bin/env node
// Demo: Cursor tool-data PII scrub (Phase L) — preToolUse / postToolUse.
// Runs the REAL hook against the REAL local gateway with realistic Cursor hook
// payloads, and prints BEFORE (raw) vs AFTER (scrubbed) so the mechanism is
// visible end-to-end. Fake demo PII only (example.com / test Luhn card).
//
//   node scripts/demo-tool-scrub.mjs
//
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "cursor-tool-redact-hook.mjs");
const HOST = process.env.GATEWAY_HOST || "127.0.0.1";
const PORT = process.env.GATEWAY_PORT || "8000";

const B = "\x1b[1m", D = "\x1b[2m", G = "\x1b[32m", R = "\x1b[31m", C = "\x1b[36m", X = "\x1b[0m";

// Realistic fake PII (Cursor sends these inside tool data).
const EMAIL = "jane.doe@example.com";
const SSN = "078-05-1120";
const CC = "4111 1111 1111 1111";

function health() {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path: "/healthz", timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function runHook(payload, portOverride) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [HOOK], {
      env: { ...process.env, GATEWAY_HOST: HOST, GATEWAY_PORT: String(portOverride || PORT), GATEWAY_ENV_BOOTSTRAPPED: "1" },
    });
    let out = "";
    cp.stdout.on("data", (d) => (out += d));
    cp.on("close", (code) => resolve({ code, out: out.trim() }));
    cp.stdin.write(JSON.stringify(payload));
    cp.stdin.end();
  });
}

function noRaw(s) {
  return !s.includes(EMAIL) && !s.includes(SSN) && !s.includes(CC);
}
const nRedacted = (s) => (String(s).match(/\[REDACTED_PII_/g) || []).length;

async function main() {
  console.log(`\n${B}Cursor tool-data PII scrub — live demo (Phase L)${X}`);
  console.log(`${D}gateway ${HOST}:${PORT} · real hook: scripts/cursor-tool-redact-hook.mjs${X}\n`);

  if (!(await health())) {
    console.log(`${R}Gateway not reachable at ${HOST}:${PORT}.${X}`);
    console.log(`Start it first:  ${C}npm start${X}   (or: node scripts/gateway-service.mjs restart)\n`);
    process.exit(1);
  }

  // 1) postToolUse — an MCP tool returns a customer record full of PII.
  console.log(`${B}1) postToolUse${X}  ${D}an MCP tool returns a record containing PII${X}`);
  const toolOutput = JSON.stringify({ content: [{ type: "text", text: `email ${EMAIL}, ssn ${SSN}, card ${CC}` }] });
  console.log(`   ${D}BEFORE (what the tool produced):${X}\n   ${toolOutput}`);
  const post = await runHook({ hook_event_name: "postToolUse", tool_name: "MCP:read_customer", tool_input: { id: 42 }, tool_output: toolOutput });
  const postScrubbed = JSON.parse(post.out).updated_mcp_tool_output;
  console.log(`   ${G}AFTER (what the model would receive):${X}\n   ${postScrubbed}`);
  console.log(`   ${C}PII items scrubbed: ${nRedacted(postScrubbed)}${X}`);
  console.log(`   ${noRaw(post.out) ? G + "✓ no raw PII in hook output" : R + "✗ RAW PII LEAKED"}${X}\n`);

  // 2) preToolUse — the model tries to send PII into a tool.
  console.log(`${B}2) preToolUse${X}  ${D}the model passes PII into a tool call${X}`);
  const toolInput = { title: "signup", meta: { reporter: EMAIL, priority: 2 }, tags: [`cc:${CC}`] };
  console.log(`   ${D}BEFORE (tool input from the model):${X}\n   ${JSON.stringify(toolInput)}`);
  const pre = await runHook({ hook_event_name: "preToolUse", tool_name: "create_ticket", tool_input: toolInput });
  const preScrubbed = JSON.parse(pre.out).updated_input;
  console.log(`   ${G}AFTER (scrubbed input the tool receives):${X}\n   ${JSON.stringify(preScrubbed)}`);
  console.log(`   ${C}PII items scrubbed: ${nRedacted(JSON.stringify(preScrubbed))}${X}`);
  console.log(`   ${noRaw(pre.out) ? G + "✓ no raw PII; non-PII fields (priority) preserved" : R + "✗ RAW PII LEAKED"}${X}\n`);

  // 3) fail-closed — gateway unreachable must never pass raw through.
  console.log(`${B}3) fail-closed${X}  ${D}if the gateway is down, never pass raw data${X}`);
  const dead = Number(PORT) + 1;
  const fpre = await runHook({ hook_event_name: "preToolUse", tool_name: "http_post", tool_input: { body: `card ${CC}` } }, dead);
  const fpost = await runHook({ hook_event_name: "postToolUse", tool_name: "http_post", tool_output: `email ${EMAIL}` }, dead);
  const preDeny = JSON.parse(fpre.out).permission === "deny";
  const postWithheld = /withheld/i.test(JSON.parse(fpost.out).updated_mcp_tool_output || "");
  console.log(`   preToolUse  → ${preDeny ? G + "DENY (tool blocked)" : R + "NOT denied"}${X}`);
  console.log(`   postToolUse → ${postWithheld ? G + "WITHHELD (output replaced)" : R + "NOT withheld"}${X}`);
  console.log(`   ${noRaw(fpre.out) && noRaw(fpost.out) ? G + "✓ no raw PII even on failure" : R + "✗ RAW PII LEAKED"}${X}\n`);

  console.log(`${B}Summary:${X} tool data is scrubbed on your machine before it leaves for Cursor's cloud;`);
  console.log(`on gateway failure the hook fails closed (deny / withhold) — raw PII never passes.\n`);
}

main();
