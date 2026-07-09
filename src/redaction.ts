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

// 7 default rules (§3.1). Order matters only for exact-tie overlap resolution.
export const DEFAULT_RULES: RedactionRule[] = [
  {
    name: "API_KEY",
    pattern:
      /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/g,
  },
  { name: "BEARER_TOKEN", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { name: "EMAIL", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    name: "CREDIT_CARD",
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    validate: luhnValid,
  },
  { name: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    name: "IPV4",
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  {
    // require >=4 groups so wall-clock "12:34:56" doesn't match (§3.1)
    name: "IPV6",
    pattern:
      /\b(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}\b|::(?:[0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4}\b/g,
  },
];

export interface RuleSource {
  rule: RedactionRule;
  source: "custom-env" | "custom-file" | "default";
}

let ACTIVE_RULES: RuleSource[] | null = null;

function parseCustomRules(
  json: string,
  source: "custom-env" | "custom-file",
): RuleSource[] {
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
    const flags = r.flags ?? "g";
    let pattern: RegExp;
    try {
      pattern = new RegExp(r.pattern, flags.includes("g") ? flags : flags + "g");
    } catch (e) {
      throw new Error(`${source}[${i}] bad regex: ${(e as Error).message}`);
    }
    return { rule: { name: r.name, pattern }, source };
  });
}

/** Compile rules once (custom merged AHEAD of defaults — they win exact ties). */
export function getRuleSources(): RuleSource[] {
  if (ACTIVE_RULES) return ACTIVE_RULES;
  const custom: RuleSource[] = [];
  if (process.env.CUSTOM_REGEX_RULES) {
    custom.push(...parseCustomRules(process.env.CUSTOM_REGEX_RULES, "custom-env"));
  }
  if (process.env.CUSTOM_REGEX_RULES_FILE) {
    const body = fs.readFileSync(process.env.CUSTOM_REGEX_RULES_FILE, "utf8");
    custom.push(...parseCustomRules(body, "custom-file"));
  }
  ACTIVE_RULES = [
    ...custom,
    ...DEFAULT_RULES.map((rule) => ({ rule, source: "default" as const })),
  ];
  return ACTIVE_RULES;
}

/** Active rule names + provenance — feeds a future GET /rules (§4). */
export function getActiveRuleInfo(): { name: string; source: string }[] {
  return getRuleSources().map((rs) => ({ name: rs.rule.name, source: rs.source }));
}

/** Test/reload seam: drop the compiled-rule cache so env changes take effect. */
export function resetRedactionRules(): void {
  ACTIVE_RULES = null;
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
