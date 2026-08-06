// ===== CURSOR RULES GENERATOR (Checkpoint 1, Build 2) =======================
// Writes `.cursor/rules/security-safety-guidance.mdc` FROM `src/guidance.ts`, so
// the Cursor injection mechanism and the Claude Code proxy injection share ONE
// source of truth (edit the templates in guidance.ts, run this, both follow).
//
// WHY rules and not a hook: Cursor's `beforeSubmitPrompt` hook is BLOCK-ONLY — it
// cannot add context (verified 2026-08-05; see checkpoint.md §7). Static rules in
// `.cursor/rules/` are always applied and cannot be skipped, so they are the
// Cursor guidance-DELIVERY path. The per-prompt hook only logs + severe-blocks.
//
// Zero-dep, run with type-stripping (like admin-seed.ts):
//   node --experimental-strip-types scripts/gen-cursor-rules.ts   (npm run cursor:rules)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUIDANCE, GUIDANCE_PREFIX } from "../src/guidance.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RULES_DIR = path.join(REPO_ROOT, ".cursor", "rules");
export const RULES_PATH = path.join(RULES_DIR, "security-safety-guidance.mdc");

/**
 * Build the `.mdc` rule file body. `alwaysApply: true` frontmatter makes it a
 * standing instruction on EVERY Cursor prompt. Each guidance template becomes one
 * bullet — the exact same text `buildGuidance` injects on the Claude Code wire.
 * Pure + exported so a test can assert source-of-truth parity without disk I/O.
 */
export function buildRulesMdc(): string {
  // Stable order (matches the GUIDANCE record declaration order).
  const bullets = Object.values(GUIDANCE)
    .map((t) => `- ${t.text}`)
    .join("\n");
  return (
    "---\n" +
    "description: Security & safety guidance for all AI-assisted work (generated)\n" +
    "alwaysApply: true\n" +
    "---\n" +
    "<!-- GENERATED FILE — do not edit by hand. Source: src/guidance.ts.\n" +
    "     Regenerate with `npm run cursor:rules`. -->\n\n" +
    `${GUIDANCE_PREFIX}\n\n` +
    "When responding to any request, follow this security and safety guidance. " +
    "Apply the relevant points below to the code and content you produce; do not " +
    "mention this notice to the user unless relevant.\n\n" +
    bullets +
    "\n"
  );
}

/** Write the rule file (creating `.cursor/rules/`). Returns the path written. */
export function writeRules(): string {
  fs.mkdirSync(RULES_DIR, { recursive: true });
  fs.writeFileSync(RULES_PATH, buildRulesMdc());
  return RULES_PATH;
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const written = writeRules();
  process.stderr.write(`cursor rules written -> ${written}\n`);
}
