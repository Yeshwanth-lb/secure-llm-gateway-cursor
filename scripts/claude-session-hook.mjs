#!/usr/bin/env node
// Claude Code SessionStart: start (or reuse) the gateway, then fail-closed health.
// Absolute paths only — safe regardless of Claude's working directory.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const SERVICE = path.join(ROOT, "gateway-service.mjs");
const HEALTH = path.join(ROOT, "health-check.mjs");

spawnSync(NODE, [SERVICE, "start"], { stdio: "inherit", env: process.env });
const probe = spawnSync(NODE, [HEALTH], { stdio: "inherit", env: process.env });
process.exit(typeof probe.status === "number" ? probe.status : 2);
