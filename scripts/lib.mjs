// Shared helpers for the cross-platform gateway installer + hooks.
// Zero dependencies — Node built-ins only. Plain ESM (.mjs) so hooks run with a
// bare `node script.mjs`, no --experimental-strip-types needed.
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HOST = process.env.GATEWAY_HOST || "127.0.0.1";
export const PORT = Number(process.env.PORT || process.env.GATEWAY_PORT || 8000);
/** Public URL clients use (hooks, MCP). Falls back to loopback host:port. */
export const BASE_URL = (process.env.GATEWAY_PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/$/, "");
export const SERVICE_LABEL = "tech.skylo.secure-llm-gateway";
export const MCP_SERVER_NAME = "secure-gateway";

/** Repo root = parent of this scripts/ dir. Never hard-code an absolute path. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRY = path.join(REPO_ROOT, "secure-llm-gateway.ts");

/** Managed state dir (installId, logs) — overridable so tests stay hermetic. */
export const STATE_DIR = process.env.GATEWAY_STATE_DIR || path.join(os.homedir(), ".secure-llm-gateway");
export const LOG_FILE = path.join(STATE_DIR, "gateway.log");
export const INSTALL_ID_FILE = path.join(STATE_DIR, "install-id");

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

/** Stable per-deployment id; created once, reused thereafter. */
export function getOrCreateInstallId() {
  ensureStateDir();
  try {
    const id = fs.readFileSync(INSTALL_ID_FILE, "utf8").trim();
    if (id) return id;
  } catch { /* not yet created */ }
  const id = "inst-" + Math.abs(hashStr(REPO_ROOT + ":" + PORT)).toString(36) + "-" + Date.now().toString(36);
  fs.writeFileSync(INSTALL_ID_FILE, id + "\n");
  return id;
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return h | 0;
}

/** GET a JSON endpoint on the gateway. Resolves {status, json} or rejects. */
export function getJson(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE_URL.endsWith("/") ? BASE_URL : BASE_URL + "/");
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, { headers, timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* non-json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** Read the persisted install id, or null if not yet created. */
export function readInstallId() {
  try {
    const id = fs.readFileSync(INSTALL_ID_FILE, "utf8").trim();
    return id || null;
  } catch {
    return null;
  }
}

/** True (+installId) if THIS deployment's gateway answers /healthz. */
export async function health() {
  const expected = readInstallId();
  try {
    const { status, json } = await getJson("/healthz");
    if (status === 200 && json && json.status === "ok") {
      const installMatch = !expected || json.installId === expected;
      return {
        ok: installMatch,
        installId: json.installId,
        host: json.host,
        port: json.port,
        foreign: expected != null && json.installId !== expected,
      };
    }
  } catch { /* down */ }
  return { ok: false };
}

/** Kill whatever process is LISTENing on `port` (best-effort, cross-platform). */
export function killPortListener(port = PORT) {
  if (process.platform === "win32") {
    try {
      const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) continue;
        const pid = Number(line.trim().split(/\s+/).pop());
        if (pid > 0) {
          try {
            execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return;
  }
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid));
      } catch { /* ignore */ }
    }
  } catch { /* nothing listening or lsof missing */ }
}

/** Poll /healthz until healthy or timeout. */
export async function waitHealthy(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  // Date.now in a loop is fine here (a plain script, not a workflow).
  while (Date.now() < deadline) {
    const h = await health();
    if (h.ok) return h;
    await sleep(400);
  }
  return { ok: false };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Deep-merge `patch` into `target` (objects merged, arrays/scalars replaced). */
export function deepMerge(target, patch) {
  if (Array.isArray(patch) || typeof patch !== "object" || patch === null) return patch;
  const out = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const k of Object.keys(patch)) out[k] = deepMerge(out[k], patch[k]);
  return out;
}

/** Append hook entries per event without clobbering existing user hooks. */
export function mergeHookEvents(target, patch) {
  const out = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k !== "hooks") out[k] = deepMerge(out[k], v);
  }
  const curHooks = out.hooks && typeof out.hooks === "object" ? { ...out.hooks } : {};
  const patchHooks = patch?.hooks && typeof patch.hooks === "object" ? patch.hooks : {};
  for (const [event, entries] of Object.entries(patchHooks)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const existing = Array.isArray(curHooks[event]) ? [...curHooks[event]] : [];
    const seen = new Set(existing.map((e) => JSON.stringify(e)));
    for (const entry of entries) {
      const key = JSON.stringify(entry);
      if (!seen.has(key)) {
        existing.push(entry);
        seen.add(key);
      }
    }
    curHooks[event] = existing;
  }
  out.hooks = curHooks;
  return out;
}

/** Read a JSON file, or {} if missing/invalid (never throws). */
export function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

export function log(msg) {
  process.stderr.write(msg + "\n"); // diagnostics on stderr; never secrets
}
