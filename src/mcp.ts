// ===== MCP SERVER (Phase B3) ================================================
// One JSON-RPC 2.0 dispatcher shared by three transports (newplan §5):
//   1. Streamable HTTP  — POST /mcp -> application/json; DELETE /mcp terminates.
//   2. Legacy HTTP+SSE  — GET /mcp -> `endpoint` event; POST /mcp/messages -> 202,
//      response delivered over the SSE stream.
//   3. stdio            — newline-delimited JSON-RPC on stdin/stdout (see bootstrap).
// The dispatcher reads live in-process traffic-log data, so `get_traffic_logs`
// reflects real requests as they happen.
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { trafficLog } from "./traffic-log.ts";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "secure-llm-gateway", version: "0.0.0" };

const GET_TRAFFIC_LOGS_TOOL = {
  name: "get_traffic_logs",
  description:
    "Return recent proxied requests (newest first) with post-redaction snapshots and matched-rule counts.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max entries, 1–100 (default 100)" },
      filter_redacted: {
        type: "boolean",
        description: "Only entries where PII was detected",
      },
    },
    additionalProperties: false,
  },
};

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse = Record<string, unknown>;

function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function callGetTrafficLogs(args: Record<string, unknown>): unknown {
  const rawLimit = typeof args.limit === "number" ? args.limit : 100;
  const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
  const filter = args.filter_redacted === true;
  const entries = trafficLog.recent(limit, filter);
  return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
}

/** Dispatch one JSON-RPC message. Returns a response object, or null for notifications. */
export function dispatch(msg: JsonRpcMessage): JsonRpcResponse | null {
  const notification = !("id" in msg) || msg.id === undefined;
  const id = (msg.id ?? null) as string | number | null;
  const method = msg.method;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
      return null;
    case "ping":
      return notification ? null : rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: [GET_TRAFFIC_LOGS_TOOL] });
    case "tools/call": {
      const name = msg.params?.name as string | undefined;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "get_traffic_logs") return rpcResult(id, callGetTrafficLogs(args));
      return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      if (notification || method?.startsWith("notifications/")) return null;
      return rpcError(id, -32601, `Method not found: ${String(method)}`);
  }
}

// ---- HTTP transports --------------------------------------------------------

/** Legacy HTTP+SSE sessions: sessionId -> open SSE response stream. */
const sseSessions = new Map<string, ServerResponse>();

export function isMcpPath(path: string): boolean {
  return path === "/mcp" || path === "/mcp/messages";
}

function writeJson(res: ServerResponse, status: number, payload: unknown, extra: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    ...extra,
  });
  res.end(body);
}

export function handleMcpHttp(
  req: IncomingMessage,
  res: ServerResponse,
  bodyBuf: Buffer,
  method: string,
  url: URL,
): void {
  const path = url.pathname;

  // Transport 2: legacy HTTP+SSE stream open.
  if (method === "GET" && path === "/mcp") {
    const sessionId = randomUUID();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: endpoint\ndata: /mcp/messages?sessionId=${sessionId}\n\n`);
    sseSessions.set(sessionId, res);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* stream gone */
      }
    }, 15000);
    if (typeof ping.unref === "function") ping.unref();
    req.on("close", () => {
      clearInterval(ping);
      sseSessions.delete(sessionId);
    });
    return;
  }

  // Transport 2: legacy message delivery — response goes out over the SSE stream.
  if (method === "POST" && path === "/mcp/messages") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const stream = sseSessions.get(sessionId);
    let response: JsonRpcResponse | null;
    try {
      response = dispatch(JSON.parse(bodyBuf.toString("utf8")) as JsonRpcMessage);
    } catch {
      response = rpcError(null, -32700, "Parse error");
    }
    res.writeHead(202);
    res.end();
    if (stream && response) stream.write(`data: ${JSON.stringify(response)}\n\n`);
    return;
  }

  // Transport 1: Streamable HTTP.
  if (method === "DELETE" && path === "/mcp") {
    res.writeHead(200);
    res.end();
    return;
  }
  if (method === "POST" && path === "/mcp") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyBuf.toString("utf8") || "null");
    } catch {
      writeJson(res, 200, rpcError(null, -32700, "Parse error"));
      return;
    }
    const batch = Array.isArray(parsed);
    const msgs = (batch ? parsed : [parsed]) as JsonRpcMessage[];
    const responses = msgs.map(dispatch).filter((r): r is JsonRpcResponse => r !== null);
    const hasInit = msgs.some((m) => m && m.method === "initialize");
    const extra = hasInit ? { "mcp-session-id": randomUUID() } : {};
    if (responses.length === 0) {
      res.writeHead(202, extra);
      res.end();
      return;
    }
    writeJson(res, 200, batch ? responses : responses[0], extra);
    return;
  }

  // Method not allowed for /mcp*.
  writeJson(res, 405, rpcError(null, -32600, "Method not allowed"));
}

// ---- stdio transport --------------------------------------------------------

/** Wire newline-delimited JSON-RPC on stdin/stdout. Diagnostics stay on stderr
 *  so stdout is protocol-pure (newplan §7). */
export function startStdioTransport(): void {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line: string) => {
    const t = line.trim();
    if (t === "") return;
    let response: JsonRpcResponse | null;
    try {
      response = dispatch(JSON.parse(t) as JsonRpcMessage);
    } catch {
      response = rpcError(null, -32700, "Parse error");
    }
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}
