// ===== REDACTION ENGINE (Phase A1) ==========================================
// newplan.md §3. Pure functions — server/logging side effects stay at the edges.
import fs from "node:fs";
import type { RedactionRule, Direction, RedactResult } from "./contracts.ts";

/** Luhn checksum — kills false-positive credit-card matches (§3.1). */
function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Skip loopback IPv4 — gateway hook messages cite 127.0.0.1; redacting it breaks context. */
function isPublicIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  return parts[0] !== 127;
}

/** Verhoeff checksum — kills false-positive Aadhaar matches. */
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
function verhoeffValid(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length !== 12) return false;
  let c = 0;
  for (let i = 0; i < 12; i++) {
    const n = d.charCodeAt(11 - i) - 48;
    if (n < 0 || n > 9) return false;
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][n]];
  }
  return c === 0;
}

// Default rules. Longer / more-specific patterns first so overlap resolution
// prefers them. Original 7 from newplan §3.1 plus high-signal Claude-session leaks.
export const DEFAULT_RULES: RedactionRule[] = [
  {
    name: "PRIVATE_KEY",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  {
    // header.payload.signature — header must be eyJ (JSON); payload/sig are base64url (+ optional = padding)
    name: "JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}=*/g,
  },
  {
    // user:pass@ in DB URLs and https basic-auth URLs
    name: "CONN_STRING",
    pattern:
      /\b(?:(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|https?):\/\/)[^:\s\/]+:[^@\s\/]+@[^\s]+/gi,
  },
  {
    name: "API_KEY",
    pattern:
      /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{16,}|sk_live_[A-Za-z0-9]{16,}|sk_test_[A-Za-z0-9]{16,}|pk_live_[A-Za-z0-9]{16,}|pk_test_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+)/g,
  },
  { name: "BEARER_TOKEN", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { name: "EMAIL", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    // require separators or +1 / parens so bare digit runs don't match
    name: "PHONE_US",
    pattern:
      /(?:\+?1[-.\s]*)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[-.\s]+\d{3}[-.\s]+\d{4}\b/g,
  },
  {
    // require +91 prefix — bare 10-digit Indian mobiles are too FP-prone alone
    name: "PHONE_IN",
    pattern: /\+91[-.\s]*[6-9]\d{4}[-.\s]?\d{5}\b/g,
  },
  {
    name: "CREDIT_CARD",
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    validate: luhnValid,
  },
  { name: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    // Indian Permanent Account Number: 5 letters + 4 digits + 1 letter
    name: "PAN_IN",
    pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
  },
  {
    // 12-digit Aadhaar, optional spaces; Verhoeff-validated
    name: "AADHAAR",
    pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    validate: verhoeffValid,
  },
  {
    name: "IPV4",
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    validate: isPublicIpv4,
  },
  {
    // require >=4 groups so wall-clock "12:34:56" doesn't match (§3.1)
    name: "IPV6",
    pattern:
      /\b(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}\b|::(?:[0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4}\b/g,
  },
];

export type RuleSourceKind = "default" | "custom-env" | "custom-file" | "custom-ui";

export interface RuleSource {
  rule: RedactionRule;
  source: RuleSourceKind;
}

// A mutable registry entry: a rule plus its live enabled state. The registry is
// the single source of truth for the control-plane console AND the proxy —
// toggles, added rules, and the allowlist take effect immediately, everywhere.
interface RuleEntry {
  rule: RedactionRule;
  source: RuleSourceKind;
  enabled: boolean;
}

interface AllowEntry {
  id: string;
  pattern: RegExp;
  source: "allow-env" | "allow-ui";
  enabled: boolean;
}

let RULES: RuleEntry[] | null = null;
let ALLOW: AllowEntry[] | null = null;
let allowSeq = 0;

function compileFlags(flags: string | undefined): string {
  const f = flags ?? "g";
  return f.includes("g") ? f : f + "g";
}

function parseCustomRules(json: string, source: RuleSourceKind): RuleEntry[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid ${source} JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(arr)) throw new Error(`${source} must be a JSON array`);
  return arr.map((raw, i) => {
    const r = raw as { name?: string; pattern?: string; flags?: string };
    if (!r || typeof r.name !== "string" || typeof r.pattern !== "string") {
      throw new Error(`${source}[${i}] needs string "name" and "pattern"`);
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(r.pattern, compileFlags(r.flags));
    } catch (e) {
      throw new Error(`${source}[${i}] bad regex: ${(e as Error).message}`);
    }
    return { rule: { name: r.name, pattern }, source, enabled: true };
  });
}

function buildRegistry(): RuleEntry[] {
  const custom: RuleEntry[] = [];
  if (process.env.CUSTOM_REGEX_RULES) {
    custom.push(...parseCustomRules(process.env.CUSTOM_REGEX_RULES, "custom-env"));
  }
  if (process.env.CUSTOM_REGEX_RULES_FILE) {
    const body = fs.readFileSync(process.env.CUSTOM_REGEX_RULES_FILE, "utf8");
    custom.push(...parseCustomRules(body, "custom-file"));
  }
  // custom merged AHEAD of defaults — they win exact-tie overlap resolution.
  return [
    ...custom,
    ...DEFAULT_RULES.map((rule) => ({ rule, source: "default" as const, enabled: true })),
  ];
}

function registry(): RuleEntry[] {
  if (!RULES) RULES = buildRegistry();
  return RULES;
}

function allowlist(): AllowEntry[] {
  if (!ALLOW) {
    ALLOW = [];
    if (process.env.CUSTOM_ALLOWLIST) {
      let arr: unknown;
      try {
        arr = JSON.parse(process.env.CUSTOM_ALLOWLIST);
      } catch {
        arr = [];
      }
      if (Array.isArray(arr)) {
        for (const raw of arr) {
          const r = raw as { pattern?: string; flags?: string };
          if (typeof r?.pattern !== "string") continue;
          try {
            ALLOW.push({
              id: `a${++allowSeq}`,
              pattern: new RegExp(r.pattern, compileFlags(r.flags)),
              source: "allow-env",
              enabled: true,
            });
          } catch {
            /* skip bad allowlist regex */
          }
        }
      }
    }
  }
  return ALLOW;
}

/** Enabled rule sources — consumed by redactText and the StreamRedactor. */
export function getRuleSources(): RuleSource[] {
  return registry()
    .filter((e) => e.enabled)
    .map((e) => ({ rule: e.rule, source: e.source }));
}

/** True if a matched substring is covered by an enabled allowlist entry. */
export function isAllowlisted(text: string): boolean {
  for (const a of allowlist()) {
    if (!a.enabled) continue;
    const re = new RegExp(a.pattern.source, compileFlags(a.pattern.flags));
    if (re.test(text)) return true;
  }
  return false;
}

// ---- control-plane surface (used by the console + /api) --------------------

export interface RuleView {
  name: string;
  pattern: string;
  flags: string;
  source: RuleSourceKind;
  enabled: boolean;
  hasValidator: boolean;
}
export interface AllowView {
  id: string;
  pattern: string;
  flags: string;
  source: string;
  enabled: boolean;
}

export function listRules(): RuleView[] {
  return registry().map((e) => ({
    name: e.rule.name,
    pattern: e.rule.pattern.source,
    flags: e.rule.pattern.flags,
    source: e.source,
    enabled: e.enabled,
    hasValidator: typeof e.rule.validate === "function",
  }));
}

export function setRuleEnabled(name: string, enabled: boolean): boolean {
  const e = registry().find((r) => r.rule.name === name);
  if (!e) return false;
  e.enabled = enabled;
  return true;
}

export function addCustomRule(name: string, pattern: string, flags?: string): RuleView {
  if (!name || !pattern) throw new Error('both "name" and "pattern" are required');
  if (registry().some((r) => r.rule.name === name)) {
    throw new Error(`a rule named "${name}" already exists`);
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, compileFlags(flags));
  } catch (e) {
    throw new Error(`bad regex: ${(e as Error).message}`);
  }
  // custom rules go AHEAD of defaults so they win overlap resolution.
  const entry: RuleEntry = { rule: { name, pattern: re }, source: "custom-ui", enabled: true };
  registry().unshift(entry);
  return listRules().find((r) => r.name === name)!;
}

export function removeRule(name: string): boolean {
  const reg = registry();
  const i = reg.findIndex((r) => r.rule.name === name);
  if (i === -1) return false;
  if (reg[i].source === "default") throw new Error("default rules cannot be removed (disable instead)");
  reg.splice(i, 1);
  return true;
}

export function listAllowlist(): AllowView[] {
  return allowlist().map((a) => ({
    id: a.id,
    pattern: a.pattern.source,
    flags: a.pattern.flags,
    source: a.source,
    enabled: a.enabled,
  }));
}

export function addAllowlistEntry(pattern: string, flags?: string): AllowView {
  if (!pattern) throw new Error('"pattern" is required');
  let re: RegExp;
  try {
    re = new RegExp(pattern, compileFlags(flags));
  } catch (e) {
    throw new Error(`bad regex: ${(e as Error).message}`);
  }
  const entry: AllowEntry = { id: `a${++allowSeq}`, pattern: re, source: "allow-ui", enabled: true };
  allowlist().push(entry);
  return { id: entry.id, pattern: re.source, flags: re.flags, source: entry.source, enabled: true };
}

export function setAllowlistEnabled(id: string, enabled: boolean): boolean {
  const a = allowlist().find((x) => x.id === id);
  if (!a) return false;
  a.enabled = enabled;
  return true;
}

export function removeAllowlistEntry(id: string): boolean {
  const list = allowlist();
  const i = list.findIndex((x) => x.id === id);
  if (i === -1) return false;
  list.splice(i, 1);
  return true;
}

/** Active rule names + provenance (enabled only) — feeds GET /rules (§4). */
export function getActiveRuleInfo(): { name: string; source: string }[] {
  return registry()
    .filter((e) => e.enabled)
    .map((e) => ({ name: e.rule.name, source: e.source }));
}

/** Test/reload seam: rebuild the registry + allowlist from defaults + env. */
export function resetRedactionRules(): void {
  RULES = null;
  ALLOW = null;
  allowSeq = 0;
}

function tokenFor(dir: Direction, ruleName: string): string {
  return dir === "inbound" ? `[REDACTED_PII_${ruleName}]` : "[REDACTED_MOCK_PII]";
}

interface Match {
  start: number;
  end: number;
  name: string;
}

/** Scrub one string. Never throws on any input — the fail-safe raw-text path. */
export function redactText(text: string, dir: Direction): RedactResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text: typeof text === "string" ? text : String(text), matched: {} };
  }
  const matches: Match[] = [];
  for (const { rule } of getRuleSources()) {
    // clone with global flag so lastIndex state is never shared across calls
    const flags = rule.pattern.flags.includes("g")
      ? rule.pattern.flags
      : rule.pattern.flags + "g";
    const re = new RegExp(rule.pattern.source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === "") {
        re.lastIndex++; // zero-length-match guard (§7)
        continue;
      }
      if (rule.validate && !rule.validate(m[0])) continue;
      if (isAllowlisted(m[0])) continue; // allowlisted values are left intact
      matches.push({ start: m.index, end: m.index + m[0].length, name: rule.name });
    }
  }
  if (matches.length === 0) return { text, matched: {} };

  // §3.2: sort by start asc, longest-first on ties; drop overlaps (first/longest wins).
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const matched: Record<string, number> = {};
  let out = "";
  let idx = 0;
  for (const mt of matches) {
    if (mt.start < idx) continue; // overlaps an already-emitted redaction
    out += text.slice(idx, mt.start) + tokenFor(dir, mt.name);
    matched[mt.name] = (matched[mt.name] ?? 0) + 1;
    idx = mt.end;
  }
  out += text.slice(idx);
  return { text: out, matched };
}

/** Deep-walk every string value in a JSON-ish structure. Object keys untouched. */
export function redactJson(
  obj: unknown,
  dir: Direction,
): { value: unknown; matched: Record<string, number> } {
  const matched: Record<string, number> = {};
  const merge = (m: Record<string, number>): void => {
    for (const k of Object.keys(m)) matched[k] = (matched[k] ?? 0) + m[k];
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactText(v, dir);
      merge(r.matched);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) {
        o[k] = walk((v as Record<string, unknown>)[k]);
      }
      return o;
    }
    return v;
  };
  return { value: walk(obj), matched };
}
