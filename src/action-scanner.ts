// ===== ACTION SCANNER — the Code Guard brain (Checkpoint 2b) ================
// Scans the CODE an AI agent just wrote for security defects. Unlike Command
// Guard (a closed, enumerable set -> Tier-1 only), generated code is open-ended,
// so scanning is TWO-TIER and both tiers run UNCONDITIONALLY in parallel:
//
//   Tier 1 — deterministic regex patterns (this file). Fast, zero-dep, zero-
//            latency. Catches the shapes patterns CAN see: string-concat SQL,
//            eval, exec-with-input, weak crypto, hardcoded secrets.
//   Tier 2 — an LLM classifier (injected). Catches what patterns CANNOT: a
//            missing-auth route, IDOR, broken access control. Tier 2 is NEVER
//            gated behind a clean Tier 1 — Tier 1 is structurally blind to
//            exactly the bugs Tier 2 exists for, so gating would hide them.
//
// Posture is fail-SAFE, the deliberate inverse of Command Guard's fail-CLOSED:
// the code is already on disk, there is nothing to block. A Tier-2 error just
// degrades to Tier-1 findings; `scanCode` NEVER throws. The guarantee is the
// regenerate follow-up + a loud audit row (see server.ts + action-guard-store).
//
// The Tier-1 core is PURE + unit-tested; the LLM seam is injected so tests stay
// hermetic (mirrors `setPromptClassifier` in prompt-analyzer.ts).

/** One security defect found in a file. */
export interface Finding {
  tier: 1 | 2;
  /** Category slug (e.g. sql_injection, missing_auth). Free-form for Tier 2. */
  category: string;
  /** Shown to the agent so it can regenerate securely. */
  message: string;
  /** 1-indexed source line (Tier 1 only; Tier 2 may omit). */
  line?: number;
}

/** A Tier-2 code scanner: content -> findings (or null on failure => ignored). */
export type CodeScanFn = (content: string, filePath?: string) => Promise<Finding[] | null>;

export interface ScanOptions {
  /** Tier-2 (LLM) enabled. When false, ONLY Tier 1 runs. */
  tier2Enabled?: boolean;
  /** The production Tier-2 scanner (from the proxy). A module override, if set, wins. */
  classify?: CodeScanFn;
  /** Hard timeout for the Tier-2 call, ms. Default 4000. */
  timeoutMs?: number;
  filePath?: string;
}

// --- Tier 1 — deterministic pattern rules -----------------------------------
// Each rule: a category + message + regexes that compile once at load (CLAUDE.md
// §2, "no eval"). Patterns are intentionally conservative — a false positive here
// only ADDS a regenerate note (fail-safe, warn-default), so we bias toward the
// clearly-dangerous shapes rather than chasing every variant.
interface Tier1Rule {
  category: string;
  message: string;
  patterns: RegExp[];
}

const TIER1_RULES: Tier1Rule[] = [
  {
    category: "sql_injection",
    message:
      "SQL query built from concatenated / interpolated input — use parameterized queries (bound placeholders), never string building.",
    patterns: [
      // "SELECT ... " + var   (string literal ending, then concatenation)
      /["'`][^"'`]*\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|UNION)\b[^"'`]*["'`]\s*\+/i,
      // `SELECT ... ${var} ...`  (template literal with interpolation)
      /`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|UNION)\b[^`]*\$\{/i,
      // f"SELECT ... {var}"  (python f-string)
      /\bf["'][^"']*\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|UNION)\b[^"']*\{/i,
      // "SELECT ... %s" % var  /  .format(  on a SQL string
      /["'][^"']*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"']*["']\s*(?:%|\.format\s*\()/i,
    ],
  },
  {
    category: "command_injection",
    message:
      "Shell/OS command built from input — avoid a shell string; pass an argv array to spawn/exec-file and never interpolate user data.",
    patterns: [
      /\b(?:child_process\.)?(?:exec|execSync)\s*\([^)]*(?:\+|\$\{|`|%|\bf["'])/i,
      /\bos\.system\s*\([^)]*(?:\+|%|\.format\s*\(|\bf["'])/i,
      /\bsubprocess\.(?:call|run|Popen)\s*\([^)]*shell\s*=\s*True/i,
    ],
  },
  {
    category: "dangerous_eval",
    message: "Dynamic code execution (eval / new Function) on runtime input — remove it; parse or dispatch explicitly instead.",
    patterns: [
      /\beval\s*\(/,
      /\bnew\s+Function\s*\(/,
    ],
  },
  {
    category: "weak_crypto",
    message: "Weak hash (MD5/SHA-1) — use SHA-256+ for integrity and a password KDF (scrypt/bcrypt/argon2) for passwords.",
    patterns: [
      /\bcreateHash\s*\(\s*["'](?:md5|sha1)["']/i,
      /\bhashlib\.(?:md5|sha1)\s*\(/i,
    ],
  },
  {
    category: "hardcoded_secret",
    message: "Hardcoded credential/secret in source — read it from an environment variable or a secret manager instead.",
    patterns: [
      // key/secret/token/password = "<non-placeholder value of some length>"
      /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i,
      // common live-key prefixes
      /["'](?:sk-live-|sk-|ghp_|AKIA|xox[baprs]-)[A-Za-z0-9_\-]{6,}["']/,
    ],
  },
  {
    category: "xss",
    message: "User input written to the DOM as HTML — sanitize/encode, or set textContent instead of innerHTML/dangerouslySetInnerHTML.",
    patterns: [
      /\bdangerouslySetInnerHTML\b/,
      /\.innerHTML\s*=(?!=)/,
      /\bdocument\.write\s*\(/,
    ],
  },
];

// A value that is obviously NOT a real secret — env lookups and placeholders.
const SECRET_FALSE_POSITIVE =
  /(process\.env|os\.environ|getenv|['"](?:xxx+|your[_-]?\w+|placeholder|changeme|example|test|dummy|redacted)['"])/i;

/**
 * Tier 1: deterministic scan. PURE. Returns a finding per (rule, matching line);
 * a line trips a category at most once. Never throws.
 */
export function scanTier1(content: string): Finding[] {
  if (typeof content !== "string" || content === "") return [];
  const lines = content.split(/\r?\n/);
  const out: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    for (const rule of TIER1_RULES) {
      if (rule.patterns.some((p) => p.test(line))) {
        // Suppress a hardcoded-secret hit that is plainly an env lookup/placeholder.
        if (rule.category === "hardcoded_secret" && SECRET_FALSE_POSITIVE.test(line)) continue;
        out.push({ tier: 1, category: rule.category, message: rule.message, line: i + 1 });
      }
    }
  }
  return out;
}

// --- module Tier-2 seam (test override, mirrors setPromptClassifier) ---------
let moduleScanner: CodeScanFn | null = null;
/** Install a Tier-2 scanner (tests inject a deterministic stub; production wires
 *  the Anthropic-upstream code classifier). When set, it wins over opts.classify. */
export function setCodeScanner(fn: CodeScanFn | null): void {
  moduleScanner = fn;
}
export function resetCodeScanner(): void {
  moduleScanner = null;
}

/** Race a promise against a timeout that resolves to null (never rejects). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, ms);
    if (typeof (t as any).unref === "function") (t as any).unref();
    p.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(v);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(null); // a rejected Tier-2 => ignored (fail-safe)
        }
      },
    );
  });
}

/** De-dupe by category+line+message (a re-scan of the same file repeats findings). */
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.category}|${f.line ?? ""}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Scan a file with BOTH tiers in parallel and merge. Tier 2 runs unconditionally
 * whenever it is enabled and a scanner is available — it is NEVER gated on a clean
 * Tier 1. Fail-SAFE: a Tier-2 error/timeout degrades to Tier-1 findings; this
 * function never throws.
 */
export async function scanCode(content: string, opts: ScanOptions = {}): Promise<Finding[]> {
  const tier1 = scanTier1(content);
  const scanner = moduleScanner ?? opts.classify;
  if (!opts.tier2Enabled || !scanner) return dedupe(tier1);
  const ms = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 4000;
  let tier2: Finding[] = [];
  try {
    const r = await withTimeout(Promise.resolve(scanner(content, opts.filePath)), ms);
    if (Array.isArray(r)) {
      tier2 = r.filter(
        (f): f is Finding =>
          !!f && typeof f.category === "string" && typeof f.message === "string",
      ).map((f) => ({ ...f, tier: 2 as const }));
    }
  } catch {
    tier2 = []; // fail-safe
  }
  return dedupe([...tier1, ...tier2]);
}
