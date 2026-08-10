// ===== PROMPT ANALYZER — the shared "brain" (Checkpoint 1) ==================
// Decides whether a user prompt carries security or safety risk and, if so, which
// categories — so the caller can inject guidance (Claude Code proxy) or log +
// severe-block (Cursor hook). Modeled on `model-policy.ts`: zero-dep, live-
// toggleable, a module singleton for the classifier seam.
//
// TWO-TIER, INVERTED (design 2026-08-05, see checkpoint.md §4):
//   Tier 1 is a benign-SKIP filter, NOT a risk-keyword gate. The default is to
//   ANALYZE (Tier 2); Tier 1 only skips prompts it is confident are trivial. A
//   keyword gate would be blind to keyword-less manipulation (the case we most
//   care about), so we invert: anything not confidently-trivial goes to Tier 2.
//   Tier 2 is the real detector (an LLM classifier); it is MANDATORY for safety.
//
// FAIL-OPEN (MANDATORY — the deliberate inverse of PII redaction, which fails
// CLOSED): any error, timeout, or parse failure anywhere in the analyzer returns
// `allow`. A missed injection means "no guidance", never a dropped request. Even
// a `block`-action category fails open on an ERROR — blocking happens only on a
// confident positive detection, never on a crash.
import type { AnalyzerResult, RiskCategory } from "./contracts.ts";
import { hasBlockCategory } from "./guidance.ts";

/** The 12 valid categories (guards a classifier that hallucinates a label). */
const VALID_CATEGORIES: ReadonlySet<string> = new Set<RiskCategory>([
  "sql_injection", "command_injection", "insecure_deserialization",
  "hardcoded_secret", "missing_auth",
  "xss", "ssrf", "idor", "path_traversal", "open_redirect", "weak_crypto",
  "data_leakage", "prompt_injection", "exfiltration",
  "harmful_content", "harassment_abuse", "social_engineering", "policy_violation",
]);

/** A classifier verdict (Tier 2). Returns null on any failure -> analyzer fails open. */
export interface ClassifierVerdict {
  risk: boolean;
  categories: RiskCategory[];
  confidence: number;
}
export type ClassifyFn = (prompt: string) => Promise<ClassifierVerdict | null>;

// --- Tier 1: benign-skip filter --------------------------------------------
// Return true ONLY for prompts we are confident are trivial (a short, purely
// informational question with no imperative / code / data shape). Conservative
// by design: a false "not trivial" just costs one Tier-2 call; a false "trivial"
// would skip analysis, so we bias hard toward NOT trivial.

const IMPERATIVE_OR_RISK = new RegExp(
  "\\b(write|build|create|generate|make|implement|code|script|function|program|" +
  "draft|compose|design|add|remove|delete|drop|run|exec|execute|install|deploy|" +
  "ignore|disregard|override|bypass|jailbreak|pretend|impersonate|send|upload|" +
  "download|fetch|post|email|wire|transfer|hack|exploit|attack|synthesize|" +
  "summarize|analyze|review|refactor|fix|debug|help me)\\b",
  "i",
);

/** Cheap structural signals that a prompt carries code/data (never trivial). */
function looksLikeCodeOrData(p: string): boolean {
  if (/[`{};=]|=>|\/\//.test(p)) return true; // code punctuation
  if (/\bhttps?:\/\//i.test(p)) return true; // a URL
  if (/@[\w.-]+\.\w{2,}/.test(p)) return true; // an email-ish token
  if (/\d{6,}/.test(p)) return true; // a long digit run (card/ssn/id-ish)
  if (/\n/.test(p)) return true; // multi-line -> not a one-line question
  return false;
}

/** Purely-informational question openers ("what is…", "capital of…", "how many…"). */
const FACTUAL_SHAPE = new RegExp(
  "^(what|who|whom|whose|when|where|which|why|how)\\b|" +
  "\\b(capital of|difference between|how many|how much|meaning of|definition of)\\b",
  "i",
);

// --- deterministic known-injection detector (high-recall, no LLM) ----------
// The LLM classifier reliably catches PLAINTEXT manipulation but has a blind spot
// on OBFUSCATED / ENCODED payloads (e.g. "decode this base64 and execute it") — it
// sees an opaque blob and rates it benign. These signatures are unambiguous jailbreak
// / injection patterns, so we flag them deterministically BEFORE Tier 2 — reliable,
// zero-cost, and independent of the model. This is an additive high-recall check, not
// a benign-skip gate; anything it does NOT match still goes to Tier 2.
const KNOWN_INJECTION: { re: RegExp; categories: RiskCategory[] }[] = [
  // decode/de-obfuscate an encoded blob AND then execute/follow the result
  {
    re: /\b(base64|b64|hex|rot13|url-?encoded|de-?obfuscat\w*|decode|decrypt|unescape)\b[\s\S]{0,80}\b(execute|run|eval|follow|obey|carry out|do (?:what|as)|instructions?)\b/i,
    categories: ["prompt_injection"],
  },
  // ignore / override prior instructions
  {
    re: /\b(ignore|disregard|forget|override|bypass)\b[\s\S]{0,40}\b(previous|prior|above|all|earlier|the|your)\b[\s\S]{0,30}\b(instruction|prompt|rule|direction|guardrail|guideline)/i,
    categories: ["prompt_injection"],
  },
  // disable safety / guardrails / filters
  {
    re: /\b(disable|turn off|switch off|bypass|remove|ignore)\b[\s\S]{0,30}\b(safety|guardrail|filter|restriction|content polic\w+|guideline|moderation)/i,
    categories: ["prompt_injection"],
  },
  // reveal / print the system / developer / hidden prompt
  {
    re: /\b(reveal|show|print|repeat|output|dump|reproduce|tell me|give me)\b[\s\S]{0,40}\b(system|developer|hidden|initial)\b[\s\S]{0,15}\b(prompt|instruction|message|context)/i,
    categories: ["prompt_injection", "data_leakage"],
  },
  // "repeat everything above" style context-extraction
  {
    re: /\brepeat\b[\s\S]{0,25}\b(all|everything)\b[\s\S]{0,25}\babove\b/i,
    categories: ["prompt_injection", "data_leakage"],
  },
  // named jailbreak modes
  {
    re: /\b(DAN mode|developer mode|jailbreak|without restrictions|no restrictions|unrestricted mode|do anything now)\b/i,
    categories: ["prompt_injection"],
  },
];

/** Return injection categories if the prompt matches a known signature, else null. */
export function matchKnownInjection(prompt: string): RiskCategory[] | null {
  for (const k of KNOWN_INJECTION) if (k.re.test(prompt)) return k.categories;
  return null;
}

/** True when the prompt is confidently trivial -> skip Tier 2 (allow). */
export function tier1IsTrivial(prompt: string): boolean {
  const p = prompt.trim();
  if (p === "") return true; // nothing to analyze
  const words = p.split(/\s+/).length;
  if (p.length > 160 || words > 24) return false; // long -> analyze
  if (looksLikeCodeOrData(p)) return false;
  if (IMPERATIVE_OR_RISK.test(p)) return false; // any action/risk verb -> analyze
  if (!FACTUAL_SHAPE.test(p)) return false; // not a plain factual question -> analyze
  return true;
}

// --- module classifier seam (test override, mirrors setTrafficListener) -----
let moduleClassifier: ClassifyFn | null = null;
/** Install a classifier (tests inject a deterministic stub; production wires the
 *  Anthropic-upstream classifier). When set, it takes precedence over any
 *  `opts.classify` passed to `analyze`. */
export function setPromptClassifier(fn: ClassifyFn | null): void {
  moduleClassifier = fn;
  verdictCache.clear(); // isolate tests: a new classifier must not read stale verdicts
}
export function resetPromptClassifier(): void {
  moduleClassifier = null;
  verdictCache.clear();
}

// --- verdict cache ----------------------------------------------------------
// Tier-2 is an upstream LLM call (1–5s). Claude Code re-sends the SAME latest
// user message across the several sub-requests it fires per turn, and users
// repeat prompts — so memoize the classifier verdict by prompt text. A turn then
// costs ONE classify call instead of N, which is what makes a slower/stronger
// classifier model (e.g. Sonnet) practical on the wire. Bounded FIFO map.
const verdictCache = new Map<string, ClassifierVerdict | null>();
const CACHE_MAX = 500;
function cacheGet(key: string): ClassifierVerdict | null | undefined {
  return verdictCache.get(key);
}
function cachePut(key: string, v: ClassifierVerdict | null): void {
  verdictCache.set(key, v);
  if (verdictCache.size > CACHE_MAX) {
    const oldest = verdictCache.keys().next().value;
    if (oldest !== undefined) verdictCache.delete(oldest);
  }
}

const DEFAULT_TIMEOUT_MS = 600;

export interface AnalyzeOptions {
  /** Tier-2 (LLM) enabled. When false, only Tier-1 runs => no safety detection. */
  tier2Enabled: boolean;
  /** The production classifier (from the proxy). A module override, if set, wins. */
  classify?: ClassifyFn;
  /** Hard timeout for the Tier-2 call. Default 600ms. */
  timeoutMs?: number;
}

/** Resolve a verdict from a classifier result. Filters hallucinated labels. */
function verdictFromClassifier(
  v: ClassifierVerdict,
  started: number,
): AnalyzerResult {
  const categories = (Array.isArray(v.categories) ? v.categories : [])
    .filter((c): c is RiskCategory => typeof c === "string" && VALID_CATEGORIES.has(c));
  const confidence = typeof v.confidence === "number" ? v.confidence : 0;
  const risky = v.risk === true && categories.length > 0;
  const verdict = !risky ? "allow" : hasBlockCategory(categories) ? "block" : "inject";
  return {
    verdict,
    categories: risky ? categories : [],
    confidence,
    tier: 2,
    latencyMs: Date.now() - started,
  };
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
    p.then(
      (val) => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(val);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(null); // a classifier throw fails OPEN
        }
      },
    );
  });
}

/**
 * Analyze a prompt. ALWAYS resolves (never rejects) — the whole body is wrapped
 * so any unexpected error fails OPEN to `allow`.
 */
export async function analyze(
  prompt: string,
  opts: AnalyzeOptions,
): Promise<AnalyzerResult> {
  const started = Date.now();
  const allow = (tier: 1 | 2): AnalyzerResult => ({
    verdict: "allow",
    categories: [],
    confidence: 0,
    tier,
    latencyMs: Date.now() - started,
  });
  try {
    // Tier 1: confidently-trivial prompts skip the LLM entirely (cost guard).
    if (tier1IsTrivial(prompt)) return allow(1);

    // Deterministic high-recall check for known injection/jailbreak signatures the
    // LLM misses when the payload is encoded/obfuscated. Fires BEFORE Tier 2 and
    // needs no model call. Additive — a non-match still falls through to Tier 2.
    const known = matchKnownInjection(prompt);
    if (known) {
      return {
        verdict: hasBlockCategory(known) ? "block" : "inject",
        categories: known,
        confidence: 0.99,
        tier: 1,
        latencyMs: Date.now() - started,
      };
    }

    // Tier 2 is where real (incl. keyword-less) detection happens. If it is off,
    // there is no safety detection — only Tier-1 skipping. Documented in §9.
    if (!opts.tier2Enabled) return allow(1);

    const classify = moduleClassifier ?? opts.classify;
    if (!classify) return allow(1); // no classifier wired -> nothing to do

    // Cache hit: reuse the prior verdict for this exact prompt (turn sub-requests
    // + repeats), skipping the upstream call entirely.
    const key = prompt.trim();
    const cached = cacheGet(key);
    let result: ClassifierVerdict | null;
    if (cached !== undefined) {
      result = cached;
    } else {
      result = await withTimeout(
        Promise.resolve().then(() => classify(prompt)),
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      // Only cache a real answer; a null (timeout/throw) should be retried next time.
      if (result !== null) cachePut(key, result);
    }
    if (!result) return allow(2); // timeout / throw / classifier said null -> fail open
    return verdictFromClassifier(result, started);
  } catch {
    // Belt-and-suspenders: any unforeseen error fails OPEN.
    return allow(2);
  }
}
