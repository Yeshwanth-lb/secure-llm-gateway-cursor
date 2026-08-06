// ===== FROZEN CONTRACTS (IMPLEMENTATION_GUIDE.md "Contracts") =================
// The seams between workstreams. Change only by mutual agreement. Type-only
// module — strips to empty at runtime.

export type Provider = "anthropic" | "gemini" | "openai";

export interface RouteResult {
  provider: Provider;
  upstreamBase: string; // resolved base URL
  forwardPath: string; // path after prefix-strip
}

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  validate?: (match: string) => boolean; // e.g. Luhn for CREDIT_CARD
}

// inbound -> [REDACTED_PII_<TYPE>], outbound -> [REDACTED_MOCK_PII]
export type Direction = "inbound" | "outbound";

export interface RedactResult {
  text: string;
  matched: Record<string, number>;
}

export interface CharCount {
  request: number;
  response: number;
  total: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  provider: Provider;
  model?: string; // model id from the request body/path, when detectable
  blocked?: boolean; // true when rejected by model-policy (not forwarded)
  /** True when this content reached the model WITHOUT passing the PII gate. Cursor
   *  does not invoke `beforeSubmitPrompt` for a message queued while the agent is
   *  busy, so such a send cannot be blocked — only recorded. `unchecked` with
   *  `piiDetected` is a real leak. */
  unchecked?: boolean;
  method: string;
  path: string;
  status: number;
  streaming: boolean;
  durationMs: number;
  charCount: CharCount;
  payloadSnapshot: { request: string; response: string };
  piiDetected: boolean;
  matchedRules: {
    inbound: Record<string, number>;
    outbound: Record<string, number>;
  };
  /** Distilled user prompt + assistant output, computed from the FULL redacted
   *  body at capture time (so it survives snapshot truncation on huge requests).
   *  Optional: absent on hook/audit entries and older log entries. */
  clean?: { userPrompt: string; assistantOutput: string };
  /** Prompt-guard (Checkpoint 1) decision METADATA — never raw prompt text. The
   *  raw prompt + exact guidance live only in the admin-gated security log
   *  (`src/security-log.ts`). Present only when the analyzer ran on this request. */
  analyzer?: AnalyzerLog;
}

// ===== PROMPT-GUARD CONTRACTS (Checkpoint 1) =================================
// The shared analyzer's verdict + the metadata recorded per decision. Detection
// is WIDE (security code + data/agent + safety), the response is one mechanism
// (steer via guidance). See checkpoint.md.

export type RiskCategory =
  // Security — code
  | "sql_injection" | "command_injection" | "insecure_deserialization"
  | "hardcoded_secret" | "missing_auth"
  // Security — implementation-risk (neutral-sounding feature requests whose naive
  // implementation is vulnerable; added 2026-08-06 to raise recall)
  | "xss" | "ssrf" | "idor" | "path_traversal" | "open_redirect" | "weak_crypto"
  // Security — data / agent
  | "data_leakage" | "prompt_injection" | "exfiltration"
  // Safety
  | "harmful_content" | "harassment_abuse" | "social_engineering" | "policy_violation";

/** Per-category response. v1 sets nearly all to "inject"; "block" is reserved for
 *  the severe set (defined so a hard-refuse category needs no re-architecting). */
export type CategoryAction = "inject" | "block";

export type AnalyzerVerdict = "allow" | "inject" | "block";

export interface AnalyzerResult {
  verdict: AnalyzerVerdict;
  categories: RiskCategory[];
  confidence: number;
  tier: 1 | 2; // which tier produced the verdict (1 = regex/skip, 2 = LLM)
  latencyMs: number;
}

/** Metadata-only view of an analyzer decision stored on a (PII-safe) LogEntry.
 *  Deliberately excludes the raw prompt and the guidance body — those go to the
 *  admin-gated security log, never here. */
export interface AnalyzerLog {
  verdict: AnalyzerVerdict;
  categories: RiskCategory[];
  confidence: number;
  tier: 1 | 2;
  guidanceInjected: boolean;
  templateIds: string[];
  latencyMs: number;
  surface: "claude-code" | "cursor-rules" | "cursor-hook";
}
