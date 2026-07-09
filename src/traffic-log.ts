// ===== TRAFFIC LOG (Phase B2 — stub) ========================================
// 100-entry ring buffer of post-redaction snapshots. Throws until B2 fills it.
import type { LogEntry } from "./contracts.ts";

const NOT_IMPL = "not implemented (phase pending)";

export const trafficLog: {
  push(e: LogEntry): void;
  recent(limit: number, filterRedacted: boolean): LogEntry[];
} = {
  push(_e: LogEntry): void {
    throw new Error(`trafficLog.push: ${NOT_IMPL} (Phase B2)`);
  },
  recent(_limit: number, _filterRedacted: boolean): LogEntry[] {
    throw new Error(`trafficLog.recent: ${NOT_IMPL} (Phase B2)`);
  },
};
