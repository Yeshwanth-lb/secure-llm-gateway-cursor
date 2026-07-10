// ===== SERVER (request dispatch + bootstrap) =================================
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { sendJson, readBody, BodyTooLargeError } from "./http-utils.ts";
import { resolveRoute } from "./routing.ts";
import { proxyRequest } from "./proxy.ts";
import { getActiveRuleInfo } from "./redaction.ts";
import { trafficLog } from "./traffic-log.ts";
import { handleMcpHttp, isMcpPath } from "./mcp.ts";
import { CONSOLE_HTML } from "./console.ts";
import { handleControlApi, isApiPath } from "./control-api.ts";
import { cleanEntry } from "./clean-view.ts";

function sendHtml(res: ServerResponse, html: string): void {
  const body = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(body.length),
  });
  res.end(body);
}

/** True when the client wants an SSE stream (MCP legacy transport), not HTML. */
function wantsEventStream(req: IncomingMessage): boolean {
  const accept = String(req.headers["accept"] ?? "");
  return /text\/event-stream/i.test(accept);
}

const NO_ROUTE_HINT = {
  error: "No route matched",
  hint: {
    message: "Prefix the path, set a provider header, or use a known API path.",
    pathPrefixes: ["/anthropic/*", "/gemini/*", "/openai/*"],
    providerHeader: "x-llm-provider: anthropic | gemini | openai",
    knownPaths: ["/v1/messages", "/v1/chat/completions", "/v1beta/*"],
  },
};

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // CORS preflight short-circuit (newplan §6).
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "*",
    });
    res.end();
    return;
  }

  // Frontend: the control-plane console (rules + allowlist + traffic inspector).
  if (method === "GET" && (path === "/" || path === "/console" || path === "/inspector")) {
    sendHtml(res, CONSOLE_HTML);
    return;
  }
  // GET /mcp in a BROWSER (Accept: text/html) serves the console; an MCP client
  // (Accept: text/event-stream) falls through to the legacy SSE transport below.
  if (method === "GET" && path === "/mcp" && !wantsEventStream(req)) {
    sendHtml(res, CONSOLE_HTML);
    return;
  }

  // Admin endpoints — answered before touching the body.
  if (method === "GET" && path === "/healthz") {
    sendJson(res, 200, { status: "ok", service: "secure-llm-gateway" });
    return;
  }
  if (method === "GET" && path === "/logs") {
    const entries = trafficLog.recent(100, false);
    // ?clean=1 attaches a distilled { userPrompt, assistantOutput } per entry,
    // stripping Claude Code's injected boilerplate (system-reminder/system/tools).
    const clean = url.searchParams.get("clean") === "1";
    sendJson(res, 200, { entries: clean ? entries.map(cleanEntry) : entries });
    return;
  }
  if (method === "GET" && path === "/rules") {
    sendJson(res, 200, { rules: getActiveRuleInfo() });
    return;
  }

  // Read the body once, enforcing the cap up front (oversized -> 413).
  let bodyBuf: Buffer;
  try {
    bodyBuf = await readBody(req, config.bodyCapBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: "Payload too large", maxBytes: config.bodyCapBytes });
      return;
    }
    sendJson(res, 400, { error: "Failed to read request body" });
    return;
  }

  // Control plane — console API (rule toggles, custom rules, allowlist).
  if (isApiPath(path)) {
    handleControlApi(req, res, bodyBuf, method, path);
    return;
  }

  // Control plane — MCP server (Streamable HTTP + legacy HTTP+SSE).
  if (isMcpPath(path)) {
    handleMcpHttp(req, res, bodyBuf, method, url);
    return;
  }

  // Data plane — resolve provider and proxy.
  const route = resolveRoute(req, config.upstreams);
  if (!route) {
    sendJson(res, 404, NO_ROUTE_HINT);
    return;
  }
  await proxyRequest(req, res, bodyBuf, route, config);
}

/** Create (but do not start) the gateway HTTP server. Tests inject config overrides. */
export function createGatewayServer(overrides: Partial<GatewayConfig> = {}): http.Server {
  const config = loadConfig(overrides);
  return http.createServer((req, res) => {
    handleRequest(req, res, config).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
      else res.end();
    });
  });
}
