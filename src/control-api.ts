// ===== CONTROL-PLANE API (/api/*) ===========================================
// JSON endpoints backing the console webpage. Every mutation acts on the live
// redaction registry, so toggles/adds/allowlist changes take effect on the
// proxy immediately — no restart. Read-only endpoints never expose raw PII.
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http-utils.ts";
import {
  listRules,
  setRuleEnabled,
  addCustomRule,
  removeRule,
  listAllowlist,
  addAllowlistEntry,
  setAllowlistEnabled,
  removeAllowlistEntry,
} from "./redaction.ts";
import { listModelPolicies, setModelBlocked } from "./model-policy.ts";

export function isApiPath(path: string): boolean {
  return path === "/api/state" || path.startsWith("/api/");
}

function parse(body: Buffer): Record<string, unknown> {
  try {
    const v = JSON.parse(body.toString("utf8") || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function state(): unknown {
  return { rules: listRules(), allowlist: listAllowlist(), models: listModelPolicies() };
}

/** Handle an /api/* request. Returns true if it owned the response. */
export function handleControlApi(
  _req: IncomingMessage,
  res: ServerResponse,
  bodyBuf: Buffer,
  method: string,
  path: string,
): boolean {
  if (method === "GET" && path === "/api/state") {
    sendJson(res, 200, state());
    return true;
  }

  if (method !== "POST") {
    if (path.startsWith("/api/")) {
      sendJson(res, 405, { error: "Use POST for control-plane mutations" });
      return true;
    }
    return false;
  }

  const b = parse(bodyBuf);
  try {
    switch (path) {
      case "/api/rules/toggle": {
        const ok = setRuleEnabled(String(b.name), Boolean(b.enabled));
        if (!ok) return sendJson(res, 404, { error: `no rule "${String(b.name)}"` }), true;
        break;
      }
      case "/api/rules/add": {
        addCustomRule(String(b.name), String(b.pattern), b.flags as string | undefined);
        break;
      }
      case "/api/rules/remove": {
        const ok = removeRule(String(b.name));
        if (!ok) return sendJson(res, 404, { error: `no rule "${String(b.name)}"` }), true;
        break;
      }
      case "/api/allowlist/add": {
        addAllowlistEntry(String(b.pattern), b.flags as string | undefined);
        break;
      }
      case "/api/allowlist/toggle": {
        const ok = setAllowlistEnabled(String(b.id), Boolean(b.enabled));
        if (!ok) return sendJson(res, 404, { error: `no allowlist entry "${String(b.id)}"` }), true;
        break;
      }
      case "/api/allowlist/remove": {
        const ok = removeAllowlistEntry(String(b.id));
        if (!ok) return sendJson(res, 404, { error: `no allowlist entry "${String(b.id)}"` }), true;
        break;
      }
      case "/api/models/toggle": {
        const ok = setModelBlocked(String(b.id), Boolean(b.blocked));
        if (!ok) return sendJson(res, 404, { error: `no model "${String(b.id)}"` }), true;
        break;
      }
      default:
        sendJson(res, 404, { error: `unknown control endpoint: ${path}` });
        return true;
    }
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
    return true;
  }

  // success — return the fresh state so the client re-renders from truth.
  sendJson(res, 200, state());
  return true;
}
