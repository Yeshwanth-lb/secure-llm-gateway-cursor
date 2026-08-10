// ===== SECURITY LOG (Checkpoint 1) ==========================================
// The SECOND log store, for the security team. UNLIKE the PII-safe `trafficLog`
// (metadata + post-redaction snapshots only), THIS store MAY hold the RAW prompt
// text and the exact guidance injected — the full detail a reviewer needs to
// judge a decision. It is therefore admin-token gated on read (`GET /security-log`
// in server.ts). In-memory ring buffer, zero-dep, mirrors `trafficLog`; gone on
// restart (like the metadata log). Only prompt-guard decisions land here, and
// only when the analyzer ACTED (verdict inject/block) — allows are not stored.
import type { AnalyzerVerdict, RiskCategory } from "./contracts.ts";

export interface SecurityLogEntry {
  id: string;
  timestamp: string;
  /** Which guard produced this row. Absent = prompt-guard (Checkpoint 1) for
   *  back-compat with existing rows. Command Guard (Checkpoint 2) sets
   *  "command-guard" and uses the command-* fields below instead of the
   *  prompt-guard fields. */
  kind?: "prompt-guard" | "command-guard" | "action-guard" | "action-guard-error";
  surface: "claude-code" | "cursor-rules" | "cursor-hook" | "cursor";
  // --- prompt-guard fields (Checkpoint 1) — present on prompt-guard rows -------
  verdict?: AnalyzerVerdict;
  categories?: RiskCategory[];
  confidence?: number;
  tier?: 1 | 2;
  /** RAW user prompt (may contain secrets/PII) — the reason this store is gated. */
  rawPrompt?: string;
  /** The exact guidance block injected (empty for a pure block/log decision). */
  guidance?: string;
  // --- command-guard fields (Checkpoint 2) — present on command-guard rows -----
  /** The RAW shell command the agent tried to run (why this store is gated). */
  command?: string;
  /** Which command category matched, and the exact rule pattern (audit detail). */
  commandCategory?: string;
  matchedPattern?: string;
  /** The verdict returned to the surface hook. */
  permission?: "allow" | "deny" | "ask";
  /** The model's reply for this turn (PII-REDACTED, same as the /logs snapshot),
   *  filled in after the turn completes. Lets a reviewer see prompt + guidance +
   *  what the model actually produced in one record. Absent until the turn ends
   *  (or on a short-circuit block, where nothing was forwarded). */
  response?: string;
  /** Where the decision was delivered/enforced. */
  provider?: string;
  model?: string;
  // --- action-guard fields (Checkpoint 2b) — present on code-scan rows ---------
  /** The file that was scanned (path only — raw code is NEVER stored here). */
  filePath?: string;
  /** The conversation/session id the findings accumulated under. */
  conversationId?: string;
  /** The security defects found (category/message/line metadata, no code). */
  findings?: { tier: 1 | 2; category: string; message: string; line?: number }[];
}

const CAP = 200;

export const securityLog: {
  push(e: SecurityLogEntry): void;
  recent(limit: number): SecurityLogEntry[];
  attachResponse(surface: SecurityLogEntry["surface"], turnPrompt: string, response: string): boolean;
  clear(): void;
} = (() => {
  const buf: SecurityLogEntry[] = [];
  return {
    push(e: SecurityLogEntry): void {
      buf.push(e);
      if (buf.length > CAP) buf.shift();
    },
    recent(limit: number): SecurityLogEntry[] {
      const items = buf.slice().reverse(); // newest first
      const n = Math.max(0, Math.min(Number.isFinite(limit) ? limit : CAP, CAP));
      return items.slice(0, n);
    },
    // Back-fill the model reply onto the most-recent matching entry that still
    // lacks one. Used for the CURSOR surface: its reply is off-wire (Cursor calls
    // the model server-side), captured only by the stop turn-log hook — so the
    // flagged `cursor-hook` row is written at submit with no `response`, and this
    // joins the later reply to it. The two Cursor hooks share NO turn id, so the
    // ONLY join key is the prompt text: match when the flagged prompt equals the
    // turn prompt, or is contained in it (a multi-message turn concatenates its
    // user parts). Best-effort correlation for security-team visibility, not
    // enforcement. `response` must already be REDACTED by the caller (PII-safe).
    attachResponse(
      surface: SecurityLogEntry["surface"],
      turnPrompt: string,
      response: string,
    ): boolean {
      const needle = (turnPrompt ?? "").trim();
      if (needle === "") return false;
      for (let i = buf.length - 1; i >= 0; i--) {
        const e = buf[i];
        if (e.surface !== surface || e.response !== undefined) continue;
        const flagged = (e.rawPrompt ?? "").trim();
        if (flagged !== "" && (flagged === needle || needle.includes(flagged))) {
          e.response = response;
          return true;
        }
      }
      return false;
    },
    clear(): void {
      buf.length = 0;
    },
  };
})();
