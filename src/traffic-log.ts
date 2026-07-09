// ===== TRAFFIC LOG (Phase B2) ===============================================
// In-memory ring buffer of the last 100 requests. Snapshots are ALWAYS stored
// post-redaction (newplan §4) — this buffer must never hold raw PII. `recent`
// returns newest-first.
import type { LogEntry } from "./contracts.ts";

const CAP = 100;

export const trafficLog: {
  push(e: LogEntry): void;
  recent(limit: number, filterRedacted: boolean): LogEntry[];
  clear(): void;
} = (() => {
  const buf: LogEntry[] = [];
  return {
    push(e: LogEntry): void {
      buf.push(e);
      if (buf.length > CAP) buf.shift();
    },
    recent(limit: number, filterRedacted: boolean): LogEntry[] {
      let items = buf.slice().reverse(); // newest first
      if (filterRedacted) items = items.filter((e) => e.piiDetected);
      const n = Math.max(0, Math.min(Number.isFinite(limit) ? limit : CAP, CAP));
      return items.slice(0, n);
    },
    clear(): void {
      buf.length = 0;
    },
  };
})();
