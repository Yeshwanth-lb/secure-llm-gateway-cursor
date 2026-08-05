// ===== TRAFFIC LOG (Phase B2) ===============================================
// In-memory ring buffer of the last 100 requests. Snapshots are ALWAYS stored
// post-redaction (newplan §4) — this buffer must never hold raw PII. `recent`
// returns newest-first.
import type { LogEntry } from "./contracts.ts";

const CAP = 100;

// Optional post-push listener. The admin subsystem registers one to persist an
// analytics event per decision (metadata only, no raw PII). Kept as a single
// nullable hook so the ring buffer stays dependency-free and every existing
// `trafficLog.push` call site emits an event without being edited. The listener
// must never throw (it is wrapped below) — analytics is best-effort and must
// never affect traffic.
let onPush: ((e: LogEntry) => void) | null = null;
export function setTrafficListener(fn: ((e: LogEntry) => void) | null): void {
  onPush = fn;
}

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
      if (onPush) {
        try {
          onPush(e);
        } catch {
          /* never let the analytics hook affect traffic */
        }
      }
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
