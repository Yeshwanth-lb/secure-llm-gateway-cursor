// ===== ADMIN API (Phase U) — /admin/api/* + /internal/* ======================
// Mirrors control-api.ts. Two trust tiers:
//   /admin/api/*  — the dashboard. `POST /admin/api/login` issues a JWT; every
//                   other route requires a valid Bearer JWT (401 otherwise).
//   /internal/*   — enforcement-point plumbing (loopback-gated by the server, no
//                   JWT). `POST /internal/events` is FIRE-AND-FORGET: it always
//                   returns fast and swallows errors so a caller is never blocked.
//                   `GET /internal/config/:surface` returns the live surface config.
//
// The origin/loopback gate is applied by the server before this runs.
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http-utils.ts";
import type { GatewayConfig } from "./config.ts";
import { openAdminStore, modesForSurface, SURFACES, type Mode } from "./admin-store.ts";
import { authFromRequest, jwtSecret, signJWT, verifyPassword, allowLoginAttempt } from "./admin-auth.ts";
import { listRules, setRuleEnabled, redactText } from "./redaction.ts";
import { handleControlApi } from "./control-api.ts";
import { trafficLog } from "./traffic-log.ts";
import { cleanEntry } from "./clean-view.ts";

export function isAdminPath(path: string): boolean {
  return path.startsWith("/admin/api/") || path.startsWith("/internal/");
}

function parse(body: Buffer): Record<string, any> {
  try {
    const v = JSON.parse(body.toString("utf8") || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function sendText(res: ServerResponse, status: number, text: string, contentType: string, filename?: string): void {
  const body = Buffer.from(text, "utf8");
  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-length": String(body.length),
  };
  if (filename) headers["content-disposition"] = `attachment; filename="${filename}"`;
  res.writeHead(status, headers);
  res.end(body);
}

/** Handle /admin/api/* and /internal/*. Returns true if it owned the response. */
export function handleAdminApi(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
  bodyBuf: Buffer,
  method: string,
  url: URL,
): boolean {
  if (!config.adminEnabled) {
    sendJson(res, 404, { error: "admin subsystem disabled" });
    return true;
  }
  const path = url.pathname;
  const store = openAdminStore(config.adminDbPath);
  const secret = jwtSecret(config);

  // --- INTERNAL (loopback, no JWT) ------------------------------------------
  if (path === "/internal/events") {
    // Fire-and-forget: accept, record best-effort, ALWAYS 202. Never blocks/errors a caller.
    if (method !== "POST") return sendJson(res, 405, { error: "POST only" }), true;
    try {
      store.recordEvent(parse(bodyBuf) as any);
    } catch {
      /* swallow */
    }
    sendJson(res, 202, { ok: true });
    return true;
  }
  if (path.startsWith("/internal/config/")) {
    if (method !== "GET") return sendJson(res, 405, { error: "GET only" }), true;
    const surface = decodeURIComponent(path.slice("/internal/config/".length));
    const cfg = store.getSurfaceConfig(surface);
    // Also surface the global PII-type enable state (drives the engine directly).
    const globalPii = Object.fromEntries(listRules().map((r) => [r.name, r.enabled]));
    sendJson(res, 200, { ...cfg, globalPiiTypes: globalPii, version: store.configVersion() });
    return true;
  }

  // --- ADMIN LOGIN (no JWT yet) ---------------------------------------------
  if (path === "/admin/api/login") {
    if (method !== "POST") return sendJson(res, 405, { error: "POST only" }), true;
    const ip = req.socket?.remoteAddress ?? "unknown";
    if (!allowLoginAttempt(ip)) {
      sendJson(res, 429, { error: "too many attempts — wait a minute" });
      return true;
    }
    const b = parse(bodyBuf);
    const username = String(b.username ?? "");
    const password = String(b.password ?? "");
    const user = store.getUser(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      sendJson(res, 401, { error: "invalid credentials" });
      return true;
    }
    store.touchLogin(username);
    const token = signJWT({ sub: username, role: user.role }, secret);
    sendJson(res, 200, { token, username, role: user.role, expiresInSec: 8 * 60 * 60 });
    return true;
  }

  // --- ALL OTHER /admin/api/* REQUIRE A VALID JWT ---------------------------
  const auth = authFromRequest(req, secret);
  if (!auth) {
    sendJson(res, 401, { error: "authentication required" });
    return true;
  }
  const admin = String(auth.sub ?? "admin");

  try {
    if (method === "GET" && path === "/admin/api/analytics") {
      const range = url.searchParams.get("range") ?? "7d";
      const surface = url.searchParams.get("surface") ?? undefined;
      const decision = url.searchParams.get("decision") ?? undefined;
      sendJson(res, 200, {
        analytics: store.analytics(range, surface || undefined, decision || undefined),
        surfaces: SURFACES,
      });
      return true;
    }

    if (method === "GET" && path === "/admin/api/events") {
      const opts = {
        surface: url.searchParams.get("surface") || undefined,
        decision: url.searchParams.get("decision") || undefined,
        range: url.searchParams.get("range") || "7d",
        limit: Number(url.searchParams.get("limit")) || 1000,
      };
      if (url.searchParams.get("format") === "csv") {
        sendText(res, 200, store.eventsCsv(opts), "text/csv; charset=utf-8", "events.csv");
        return true;
      }
      sendJson(res, 200, { events: store.queryEvents(opts) });
      return true;
    }

    if (method === "GET" && path === "/admin/api/surfaces") {
      sendJson(res, 200, { surfaces: store.listSurfaces(), catalog: SURFACES });
      return true;
    }

    if (method === "PUT" && path.startsWith("/admin/api/surfaces/")) {
      const surface = decodeURIComponent(path.slice("/admin/api/surfaces/".length));
      const known = SURFACES.some((s) => s.surface === surface);
      if (!known) return sendJson(res, 404, { error: `unknown surface "${surface}"` }), true;
      const b = parse(bodyBuf);
      const patch: any = {};
      if ("enabled" in b) patch.enabled = Boolean(b.enabled);
      if ("fail_mode" in b) patch.fail_mode = b.fail_mode === "open" ? "open" : "closed";
      if ("pii_type_toggles" in b && b.pii_type_toggles && typeof b.pii_type_toggles === "object")
        patch.pii_type_toggles = b.pii_type_toggles;
      if ("mode" in b) {
        const mode = String(b.mode) as Mode;
        if (!modesForSurface(surface).includes(mode)) {
          sendJson(res, 400, {
            error: `mode "${mode}" not valid for ${surface} (allowed: ${modesForSurface(surface).join(", ")})`,
          });
          return true;
        }
        patch.mode = mode;
      }
      const next = store.setSurfaceConfig(surface, patch, admin);
      sendJson(res, 200, { surface: next });
      return true;
    }

    if (method === "GET" && path === "/admin/api/pii-types") {
      sendJson(res, 200, { types: listRules().map((r) => ({ name: r.name, enabled: r.enabled })) });
      return true;
    }

    if (method === "PUT" && path.startsWith("/admin/api/pii-types/")) {
      const name = decodeURIComponent(path.slice("/admin/api/pii-types/".length));
      const b = parse(bodyBuf);
      const enabled = Boolean(b.enabled);
      const ok = setRuleEnabled(name, enabled); // drives the LIVE redaction engine, all surfaces
      if (!ok) return sendJson(res, 404, { error: `no PII rule "${name}"` }), true;
      store.appendAudit({ admin, action: "pii_type.toggle", target: name, after: { enabled } });
      sendJson(res, 200, { name, enabled });
      return true;
    }

    if (method === "GET" && path === "/admin/api/audit") {
      const opts = {
        admin: url.searchParams.get("admin") || undefined,
        action: url.searchParams.get("action") || undefined,
        from: Number(url.searchParams.get("from")) || undefined,
        to: Number(url.searchParams.get("to")) || undefined,
        limit: Number(url.searchParams.get("limit")) || 500,
      };
      sendJson(res, 200, { audit: store.readAudit(opts) });
      return true;
    }

    if (method === "GET" && path === "/admin/api/me") {
      sendJson(res, 200, { username: admin, role: auth.role ?? "admin" });
      return true;
    }

    // --- Mirrored Gateway-Console tabs (Rules / Allowlist / Model Policy) ------
    // Reuse the existing control-plane logic verbatim by mapping the admin path to
    // the /api/* path handleControlApi expects. JWT-gated here; console mutations
    // are audited. GET /admin/api/console -> the same {rules, allowlist, models}
    // state the console renders from.
    if (path === "/admin/api/console" || path.startsWith("/admin/api/console/")) {
      const sub = path === "/admin/api/console" ? "/api/state" : path.replace("/admin/api/console", "/api");
      if (method === "POST") store.appendAudit({ admin, action: "console" + sub.replace("/api", ""), after: parse(bodyBuf) });
      handleControlApi(req, res, bodyBuf, method === "GET" ? "GET" : "POST", method === "GET" ? "/api/state" : sub);
      return true;
    }

    // --- Traffic Inspector (mirror of GET /logs) ------------------------------
    if (method === "GET" && path === "/admin/api/logs") {
      const entries = trafficLog.recent(100, false);
      const clean = url.searchParams.get("clean") === "1";
      sendJson(res, 200, { entries: clean ? entries.map(cleanEntry) : entries });
      return true;
    }

    // --- Try Redaction (preview only — never stored) --------------------------
    if (method === "POST" && path === "/admin/api/try") {
      const b = parse(bodyBuf);
      const out = redactText(String(b.text ?? ""), "inbound");
      sendJson(res, 200, { redacted: out.text, matched: out.matched });
      return true;
    }

    sendJson(res, 404, { error: `unknown admin endpoint: ${path}` });
    return true;
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
    return true;
  }
}
