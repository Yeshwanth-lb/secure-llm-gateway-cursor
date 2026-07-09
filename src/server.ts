// ===== SERVER (request handler + bootstrap) ==================================
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { sendJson, readBody, BodyTooLargeError } from "./http-utils.ts";

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // Admin: health check — answered before touching the body.
  if (method === "GET" && path === "/healthz") {
    sendJson(res, 200, { status: "ok", service: "secure-llm-gateway" });
    return;
  }

  // Enforce the body cap up front so oversized payloads never reach routing.
  try {
    await readBody(req, config.bodyCapBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: "Payload too large", maxBytes: config.bodyCapBytes });
      return;
    }
    sendJson(res, 400, { error: "Failed to read request body" });
    return;
  }

  // Phase 0: routing/proxy not wired yet — everything else is an unknown route.
  sendJson(res, 404, {
    error: "No route matched",
    hint: {
      message: "Prefix the path, set a provider header, or use a known API path.",
      pathPrefixes: ["/anthropic/*", "/gemini/*", "/openai/*"],
      providerHeader: "x-llm-provider: anthropic | gemini | openai",
      knownPaths: ["/v1/messages", "/v1/chat/completions", "/v1beta/*"],
    },
  });
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
