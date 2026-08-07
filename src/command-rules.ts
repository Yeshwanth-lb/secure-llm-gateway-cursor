// ===== COMMAND RULES — the Command Guard brain (Checkpoint 2 v1) ============
// Deterministic pattern matcher for shell commands an AI coding agent is about to
// run. Commands are a CLOSED, enumerable set, so this is Tier-1 only — no LLM, no
// dependency; the regexes compile once at module load (CLAUDE.md §2, "no eval").
//
// Two actions:
//   deny — destructive / unrecoverable (rm -rf, curl|sh, sudo, DROP TABLE).
//   ask  — rewrites SHARED git history (force-push, reset --hard); a human should
//          confirm. Destroys other people's work, not local files — a distinct risk.
// Anything unmatched -> allow.
//
// PURE + unit-tested. The gateway endpoint (`POST /command-guard`) and both surface
// hooks call `classifyCommand`; the rule set lives ONLY here (single source of truth).

export type CommandAction = "deny" | "ask";
export type CommandPermission = "allow" | "deny" | "ask";

export type CommandCategory =
  | "destructive_fs"
  | "priv_escalation"
  | "remote_exec"
  | "infra_destructive"
  | "git_destructive";

export interface CommandVerdict {
  permission: CommandPermission;
  category: CommandCategory | null;
  /** The source of the regex that matched (audit detail; never a secret). */
  matchedPattern: string | null;
  /** Shown to the human. */
  userMessage: string;
  /** Shown to the AI agent (so it can choose a safe alternative). */
  agentMessage: string;
}

interface CommandRule {
  category: CommandCategory;
  action: CommandAction;
  patterns: RegExp[];
  userMessage: string;
  agentMessage: string;
}

// Order matters: DENY categories are listed before the ASK category, so a command
// that trips both (e.g. `sudo git push --force`) is denied, not merely asked.
const RULES: CommandRule[] = [
  {
    category: "destructive_fs",
    action: "deny",
    patterns: [
      /\brm\s+-[a-z]*r[a-z]*f\b/i, // -rf, -Rf, -rvf
      /\brm\s+-[a-z]*f[a-z]*r\b/i, // -fr
      /\brm\s+(?=(?:[^\n]*\s)?-[a-z]*r\b)(?=(?:[^\n]*\s)?-[a-z]*f\b)/i, // separate -r and -f (any order)
      /\brm\s+[^\n]*--recursive[^\n]*--force/i,
      /\brm\s+[^\n]*--force[^\n]*--recursive/i,
      /\bdd\s+[^\n]*\bif=/i,
      /\bmkfs(?:\.\w+)?\b/i,
      /(?:>|>>)\s*\/dev\/(?:sd|nvme|hd|disk|vd)\w*/i,
      /\bchmod\s+-R\s+0*777\b/i,
    ],
    userMessage: "Blocked: this command destroys files irreversibly.",
    agentMessage:
      "Command Guard denied a destructive filesystem command. Do NOT run bulk/recursive deletes, disk writes, or format commands. If a deletion is genuinely needed, scope it to specific paths and ask the user to run it themselves.",
  },
  {
    category: "priv_escalation",
    action: "deny",
    patterns: [/\bsudo\b/i, /\bsu\s+-(?:\s|$)/i, /\bsu\s+root\b/i, /\bdoas\b/i],
    userMessage: "Blocked: privilege escalation is not allowed from the agent.",
    agentMessage:
      "Command Guard denied a privilege-escalation command (sudo/su/doas). Do not attempt to run commands as another/root user; ask the user to perform any privileged step themselves.",
  },
  {
    category: "remote_exec",
    action: "deny",
    patterns: [
      /\b(?:curl|wget|fetch)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|python[0-9.]*|node|ruby|perl)\b/i,
    ],
    userMessage: "Blocked: piping a download straight into a shell runs unreviewed remote code.",
    agentMessage:
      "Command Guard denied a curl|sh / wget|bash remote-exec pipeline. Do not execute downloaded scripts unreviewed. Download to a file, let the user inspect it, then run it deliberately.",
  },
  {
    category: "infra_destructive",
    action: "deny",
    patterns: [
      /\bterraform\s+destroy\b/i,
      /\bkubectl\s+delete\b/i,
      /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
      /\bTRUNCATE\s+TABLE\b/i,
    ],
    userMessage: "Blocked: this tears down infrastructure or data.",
    agentMessage:
      "Command Guard denied a destructive infrastructure/database command (terraform destroy / kubectl delete / DROP / TRUNCATE). These are irreversible against real state; propose the change and let the user apply it deliberately.",
  },
  {
    category: "git_destructive",
    action: "ask",
    patterns: [
      /\bgit\s+push\b[^\n]*--force(?!-with-lease)/i, // --force but NOT --force-with-lease
      /\bgit\s+push\b[^\n]*(?:^|\s)-f(?:\s|$)/i, // short -f
      /\bgit\s+push\b[^\n]*--delete\b/i,
      /\bgit\s+reset\s+--hard\b/i,
      /\bgit\s+clean\s+-\w*f/i, // -f, -fd, -fdx
      /\bgit\s+branch\s+-D\b/, // capital -D = force-delete (case-sensitive)
      /\bgit\s+filter-(?:branch|repo)\b/i,
      /\bgit\s+commit\b[^\n]*--amend\b/i, // (OPEN) safe only if unpushed — ask for now
    ],
    userMessage: "Confirm: this rewrites or discards git history that others may rely on.",
    agentMessage:
      "Command Guard is holding a history-rewriting git command for user confirmation (force-push / reset --hard / clean -f / branch -D / filter-branch / amend). Prefer --force-with-lease over --force, and confirm with the user before rewriting shared history.",
  },
];

const ALLOW: CommandVerdict = {
  permission: "allow",
  category: null,
  matchedPattern: null,
  userMessage: "",
  agentMessage: "",
};

/**
 * Classify a shell command. Pure + deterministic. Returns the FIRST matching rule
 * (deny categories are checked before the ask category), or `allow` if none match.
 * An empty/whitespace command is `allow` (nothing to run).
 */
export function classifyCommand(command: string): CommandVerdict {
  if (typeof command !== "string" || command.trim() === "") return ALLOW;
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      if (p.test(command)) {
        return {
          permission: rule.action,
          category: rule.category,
          matchedPattern: p.source,
          userMessage: rule.userMessage,
          agentMessage: rule.agentMessage,
        };
      }
    }
  }
  return ALLOW;
}

/** Category list (for admin UI / docs). */
export const COMMAND_CATEGORIES: CommandCategory[] = RULES.map((r) => r.category);
