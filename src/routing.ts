// ===== ROUTING (Phase B1 — stub) ============================================
// 5-tier provider resolution lands here. Throws until B1 fills it.
import type { IncomingMessage } from "node:http";
import type { RouteResult } from "./contracts.ts";

const NOT_IMPL = "not implemented (phase pending)";

export function resolveRoute(_req: IncomingMessage): RouteResult {
  throw new Error(`resolveRoute: ${NOT_IMPL} (Phase B1)`);
}
