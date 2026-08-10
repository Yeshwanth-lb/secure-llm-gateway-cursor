// ===== ACTION CODE CLASSIFIER (Tier 2) — Checkpoint 2b ======================
// The production Tier-2 code scanner. Same constraint as the prompt classifier
// (checkpoint.md §4): ONE model call through the request's own Anthropic upstream
// — NO new key/SDK/dependency, node:https only. Anthropic-only in v1. Returns a
// Finding[] or NULL on any failure (network/non-200/unparseable) so `scanCode`
// degrades to Tier-1 only (fail-SAFE).
//
// This is the zero-dep analog to Semgrep's engine: instead of AST rules we let a
// model read the whole file and report the defects deterministic patterns miss —
// missing authorization, IDOR/broken access control, SSRF, unsafe deserialization.
import https from "node:https";
import http from "node:http";
import type { CodeScanFn, Finding } from "./action-scanner.ts";

const SYSTEM_PROMPT =
  "You are a security code reviewer for code an AI assistant just wrote. Report ONLY concrete, " +
  "high-confidence security defects a senior reviewer would block a PR on. Focus on what static " +
  "patterns MISS: missing authentication/authorization on an endpoint, broken access control / IDOR " +
  "(returning or mutating a record by a user-supplied id with no ownership check), server-side request " +
  "forgery, unsafe deserialization, and path traversal. Also report injection, hardcoded secrets, and " +
  "weak crypto if clearly present. Do NOT report style, performance, or hypothetical issues, and do NOT " +
  "invent line numbers you are unsure of. If the code is secure, return an empty findings array. " +
  'Respond ONLY with JSON: {"findings":[{"category":string,"message":string,"line":number}]}. ' +
  "category must be a lowercase snake_case slug (e.g. missing_auth, idor, ssrf, path_traversal, " +
  "insecure_deserialization, sql_injection, command_injection, xss, hardcoded_secret, weak_crypto). " +
  "message is one sentence telling the author how to fix it. line is 1-indexed or omitted. No other text.";

/** Parse a classifier's raw text into findings. Defensive: strips fences/prose,
 *  validates shape. Returns null if nothing usable (=> Tier-1-only, fail-safe). */
export function parseCodeFindings(raw: string): Finding[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
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
  const arr = (obj as any)?.findings;
  if (!Array.isArray(arr)) return null;
  const out: Finding[] = [];
  for (const f of arr) {
    if (!f || typeof f.category !== "string" || typeof f.message !== "string") continue;
    const line = typeof f.line === "number" && f.line > 0 ? Math.floor(f.line) : undefined;
    out.push({ tier: 2, category: f.category, message: f.message, line });
  }
  return out;
}

function anthropicText(json: unknown): string {
  const j = json as Record<string, any>;
  if (j && Array.isArray(j.content)) {
    return j.content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("");
  }
  return "";
}

export interface CodeClassifyContext {
  /** Upstream base URL (the SAME the requests target — Anthropic in v1). */
  upstreamBase: string;
  /** Auth/version headers to reuse. Never logged. */
  headers: Record<string, string>;
  model: string;
  timeoutMs: number;
  /** Cap on file bytes sent to the model (avoids huge-file cost/latency). */
  maxContentBytes?: number;
}

/** Build a Tier-2 CodeScanFn that classifies a file via one Anthropic call. */
export function classifyCodeViaAnthropic(ctx: CodeClassifyContext): CodeScanFn {
  return async (content: string): Promise<Finding[] | null> => {
    const cap = ctx.maxContentBytes && ctx.maxContentBytes > 0 ? ctx.maxContentBytes : 60_000;
    const clipped = content.length > cap ? content.slice(0, cap) : content;
    const body = JSON.stringify({
      model: ctx.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Review this file:\n\n" + clipped }],
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
      "accept": "application/json",
    };
    return await new Promise<Finding[] | null>((resolve) => {
      let settled = false;
      const done = (v: Finding[] | null): void => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const r = mod.request(
        {
          method: "POST",
          hostname: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: target.pathname + target.search,
          headers,
          timeout: ctx.timeoutMs > 0 ? ctx.timeoutMs : undefined,
        },
        (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          resp.on("end", () => {
            const sc = resp.statusCode ?? 500;
            if (sc !== 200) {
              process.stderr.write(`[action-guard] Tier-2 HTTP ${sc} — Tier-1 only\n`);
              return done(null);
            }
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              done(parseCodeFindings(anthropicText(json)));
            } catch {
              done(null);
            }
          });
          resp.on("error", () => done(null));
        },
      );
      r.on("error", () => done(null));
      r.on("timeout", () => {
        r.destroy();
        done(null);
      });
      r.write(body);
      r.end();
    });
  };
}
