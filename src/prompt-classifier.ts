// ===== PROMPT CLASSIFIER (Tier 2) — Checkpoint 1 ============================
// The production Tier-2 classifier. CRITICAL CONSTRAINT (checkpoint.md §4): it
// makes ONE model call through the SAME upstream the request already targets —
// NO new API key, SDK, or dependency. v1 scope is Anthropic-only (the Claude Code
// wire); other providers skip Tier 2 (Tier 1 still runs). Uses node:https only.
//
// Returns a ClassifierVerdict or null. NULL on ANY failure (network, non-200,
// unparseable) so the analyzer fails OPEN.
import https from "node:https";
import http from "node:http";
import type { ClassifierVerdict } from "./prompt-analyzer.ts";
import type { RiskCategory } from "./contracts.ts";

// HIGH-RECALL classifier (2026-08-06). Injecting guidance is low-cost (it only
// ADDS a secure-coding note, never blocks), so the prompt is tuned to err toward
// flagging any security-SENSITIVE code-generation — including neutral-sounding
// feature requests whose naive implementation is vulnerable (IDOR, XSS, SSRF,
// open redirect, path traversal, weak crypto) — while still letting purely
// conceptual/educational questions through (the benign-lookalike guard).
const SYSTEM_PROMPT =
  "You are a security and safety classifier for prompts sent to an AI coding assistant. " +
  "Goal: HIGH RECALL on security risk. If fulfilling the prompt could plausibly lead to " +
  "insecure code or unsafe behavior in a common, naive implementation, FLAG it so secure-" +
  "coding guidance can be attached. Adding guidance is cheap, so err toward flagging. " +
  "FLAG when the prompt asks to BUILD or WRITE code that handles user-controlled input in a " +
  "security-sensitive area — SQL/queries, shell/OS commands, deserialization, file paths, " +
  "fetching user-supplied URLs, authentication/authorization, returning/mutating records by id, " +
  "HTTP redirects, rendering user input into HTML/templates, secrets/config, or cryptography — " +
  "even if the wording is casual and does not mention the vulnerability. Also flag data leakage, " +
  "prompt injection, exfiltration, and safety risks (harmful, harassment, social engineering, policy). " +
  "Do NOT flag purely conceptual, explanatory, or educational questions ABOUT a topic " +
  "(e.g. 'what is SQL injection', 'explain how JWT works', 'difference between X and Y') — those " +
  "are not requests to build the risky thing. " +
  'Respond ONLY with JSON: {"risk": boolean, "categories": string[], "confidence": number}. ' +
  "Categories must be from: sql_injection, command_injection, insecure_deserialization, " +
  "hardcoded_secret, missing_auth, xss, ssrf, idor, path_traversal, open_redirect, weak_crypto, " +
  "data_leakage, prompt_injection, exfiltration, harmful_content, harassment_abuse, " +
  "social_engineering, policy_violation. No other text.";

const VALID: ReadonlySet<string> = new Set<RiskCategory>([
  "sql_injection", "command_injection", "insecure_deserialization",
  "hardcoded_secret", "missing_auth",
  "xss", "ssrf", "idor", "path_traversal", "open_redirect", "weak_crypto",
  "data_leakage", "prompt_injection", "exfiltration",
  "harmful_content", "harassment_abuse", "social_engineering", "policy_violation",
]);

/**
 * Parse a classifier's raw text into a verdict. Defensive: strips markdown code
 * fences and any prose around the JSON object, validates shape + category labels.
 * Returns null if nothing usable is found (=> analyzer fails open). PURE + unit-
 * tested; the network path below delegates to it.
 */
export function parseClassifierJson(raw: string): ClassifierVerdict | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let text = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Grab the first {...} object if there is surrounding prose.
  if (text[0] !== "{") {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    text = text.slice(start, end + 1);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const categories = (Array.isArray(o.categories) ? o.categories : [])
    .filter((c): c is RiskCategory => typeof c === "string" && VALID.has(c));
  const confidence = typeof o.confidence === "number" ? o.confidence : 0;
  return {
    risk: o.risk === true,
    categories,
    confidence,
  };
}

/** Extract the assistant text from an Anthropic Messages JSON response. */
function anthropicText(json: unknown): string {
  const j = json as Record<string, any>;
  if (j && Array.isArray(j.content)) {
    return j.content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("");
  }
  return "";
}

export interface ClassifyContext {
  /** Upstream base URL (the SAME the request targets — Anthropic in v1). */
  upstreamBase: string;
  /** Auth/version headers to reuse (x-api-key + anthropic-version). Never logged. */
  headers: Record<string, string>;
  /** Classifier call model id. */
  model: string;
  timeoutMs: number;
}

/**
 * Classify a prompt via one Anthropic Messages call on the request's own upstream.
 * Resolves to a verdict, or null on any error/non-200/timeout (fail open).
 */
export function classifyViaAnthropic(ctx: ClassifyContext) {
  return async (prompt: string): Promise<ClassifierVerdict | null> => {
    const body = JSON.stringify({
      model: ctx.model,
      max_tokens: 128,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });
    let target: URL;
    try {
      target = new URL(ctx.upstreamBase.replace(/\/+$/, "") + "/v1/messages");
    } catch {
      return null;
    }
    const mod = target.protocol === "https:" ? https : http;
    const headers: Record<string, string> = {
      ...ctx.headers,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      // The classifier response is short JSON — never a stream.
      "accept": "application/json",
    };
    return await new Promise<ClassifierVerdict | null>((resolve) => {
      let settled = false;
      const done = (v: ClassifierVerdict | null): void => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const reqOpts: https.RequestOptions = {
        method: "POST",
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        headers,
        timeout: ctx.timeoutMs > 0 ? ctx.timeoutMs : undefined,
      };
      const r = mod.request(reqOpts, (resp) => {
        const chunks: Buffer[] = [];
        resp.on("data", (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        resp.on("end", () => {
          const sc = resp.statusCode ?? 500;
          if (sc !== 200) {
            // Diagnostic: a non-200 => analyzer fails OPEN (verdict `allow`),
            // indistinguishable from a genuine benign classification. Surface it on
            // stderr so a silently-failing classifier (e.g. wrong auth) is visible.
            process.stderr.write(`[prompt-guard] classifier HTTP ${sc} — failing open (allow)\n`);
            return done(null);
          }
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            done(parseClassifierJson(anthropicText(json)));
          } catch {
            process.stderr.write(`[prompt-guard] classifier unparseable response — failing open (allow)\n`);
            done(null);
          }
        });
        resp.on("error", () => done(null));
      });
      r.on("error", (e) => {
        process.stderr.write(`[prompt-guard] classifier request error (${e?.message ?? e}) — failing open (allow)\n`);
        done(null);
      });
      r.on("timeout", () => {
        process.stderr.write(`[prompt-guard] classifier TIMEOUT — failing open (allow)\n`);
        r.destroy();
        done(null);
      });
      r.write(body);
      r.end();
    });
  };
}
