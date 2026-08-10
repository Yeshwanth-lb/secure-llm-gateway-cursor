// ===== ACTION-GUARD STORE — per-conversation findings accumulator (CK2b) ====
// Why this exists (a platform gap): `afterFileEdit`/`PostToolUse` fire PER EDIT
// and know the file; the `stop`/`Stop` hook fires PER TURN and does NOT receive
// the list of files edited that turn. So findings from each edit must accumulate
// keyed by conversation id, and be read + CLEARED exactly once when the turn ends
// (the stop hook), to build the "regenerate securely" follow-up.
//
// In-memory, zero-dep, gone on restart (like trafficLog/securityLog). NEVER holds
// raw file content — only the Finding metadata the agent needs to fix the code.
import type { Finding } from "./action-scanner.ts";

const CAP_PER_CONV = 200; // backstop against an unbounded loop hammering one id

function keyOf(f: Finding): string {
  return `${f.category}|${f.line ?? ""}|${f.message}`;
}

export const actionGuardStore: {
  append(conversationId: string, findings: Finding[]): void;
  take(conversationId: string): Finding[];
  size(conversationId: string): number;
  clear(): void;
} = (() => {
  // conversationId -> (dedupe key -> Finding)
  const byConv = new Map<string, Map<string, Finding>>();
  return {
    append(conversationId, findings) {
      if (!conversationId || !Array.isArray(findings) || findings.length === 0) return;
      let m = byConv.get(conversationId);
      if (!m) {
        m = new Map<string, Finding>();
        byConv.set(conversationId, m);
      }
      for (const f of findings) {
        if (m.size >= CAP_PER_CONV) break;
        m.set(keyOf(f), f);
      }
    },
    take(conversationId) {
      const m = byConv.get(conversationId);
      if (!m || m.size === 0) return [];
      const out = [...m.values()];
      byConv.delete(conversationId); // read-once: cleared for the next turn
      return out;
    },
    size(conversationId) {
      return byConv.get(conversationId)?.size ?? 0;
    },
    clear() {
      byConv.clear();
    },
  };
})();
