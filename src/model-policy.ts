// ===== MODEL POLICY =========================================================
// A blocklist keyed by model. When a model is blocked, the proxy rejects the
// request (403) BEFORE forwarding — nothing leaves the machine. Toggled live
// from the console; shared in-process with the proxy so changes are immediate.
//
// Each entry maps a friendly label to a case-insensitive substring matched
// against the request's model id (e.g. "claude-opus-4-8"). The catch-all
// "All Claude models" (match "claude-") covers every Claude Code model at once.
import type { Provider } from "./contracts.ts";

interface ModelEntry {
  id: string; // stable slug
  label: string; // display name
  match: string; // lowercase substring tested against the model id
  blocked: boolean;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const SEED: { label: string; match: string }[] = [
  // Cursor / third-party models
  { label: "Cursor Grok 4.5", match: "grok" },
  { label: "Composer 2.5", match: "composer" },
  { label: "GPT-5.6 Sol", match: "gpt-5.6-sol" },
  { label: "GPT-5.5", match: "gpt-5.5" },
  { label: "GPT-5.6 Terra", match: "gpt-5.6-terra" },
  { label: "GPT-5.6 Luna", match: "gpt-5.6-luna" },
  { label: "Gemini 3.1 Pro", match: "gemini-3.1-pro" },
  { label: "Gemini 3.5 Flash", match: "gemini-3.5-flash" },
  { label: "Kimi K2.7 Code", match: "kimi-k2" },
  // Claude models (Anthropic / Claude Code) — each named individually
  { label: "Claude Opus 4.8", match: "claude-opus-4-8" },
  { label: "Claude Opus 4.7", match: "claude-opus-4-7" },
  { label: "Claude Sonnet 5", match: "claude-sonnet-5" },
  { label: "Claude Sonnet 4.6", match: "claude-sonnet-4-6" },
  { label: "Claude Haiku 4.5", match: "claude-haiku-4-5" },
  { label: "Claude Fable 5", match: "claude-fable-5" },
];

let MODELS: ModelEntry[] | null = null;

function models(): ModelEntry[] {
  if (!MODELS) {
    MODELS = SEED.map((s) => ({ id: slug(s.label), label: s.label, match: s.match, blocked: false }));
  }
  return MODELS;
}

export interface ModelView {
  id: string;
  label: string;
  match: string;
  blocked: boolean;
}

export function listModelPolicies(): ModelView[] {
  return models().map((m) => ({ id: m.id, label: m.label, match: m.match, blocked: m.blocked }));
}

export function setModelBlocked(id: string, blocked: boolean): boolean {
  const m = models().find((x) => x.id === id);
  if (!m) return false;
  m.blocked = blocked;
  return true;
}

export function resetModelPolicies(): void {
  MODELS = null;
}

/** True if `modelId` matches any BLOCKED policy entry. */
export function isModelBlocked(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return models().some((m) => m.blocked && m.match !== "" && lower.includes(m.match));
}

/** Best-effort model id from a request: body `model`, or gemini path segment. */
export function extractModel(
  provider: Provider,
  forwardPath: string,
  bodyText: string,
): string | undefined {
  if (provider === "gemini") {
    const m = forwardPath.match(/\/models\/([^:/?]+)/);
    if (m) return m[1];
  }
  try {
    const obj = JSON.parse(bodyText);
    if (obj && typeof obj.model === "string") return obj.model;
  } catch {
    /* non-JSON body — no model */
  }
  return undefined;
}
