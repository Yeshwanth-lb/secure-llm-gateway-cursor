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
}
