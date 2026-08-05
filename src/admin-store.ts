// ===== ADMIN STORE (Phase U) — persisted control-plane data =================
// Zero-dependency SQLite via the Node built-in `node:sqlite` (Node >= 22.5).
// Backs the admin dashboard: an append-only event log for analytics, per-surface
// config the enforcement points read, admin users, and an append-only audit log.
//
// SECURITY INVARIANT (same as the traffic ring buffer): this DB must NEVER hold a
// raw matched PII string. Events carry only TYPE names (e.g. "EMAIL"), the surface,
// a decision, and timing. `recordEvent` sanitises `pii_types` to token-shaped
// names so even a misbehaving `/internal/events` caller cannot persist a value.
//
// SQL is kept ANSI-plain (no SQLite-only syntax beyond AUTOINCREMENT) so a later
// move to Postgres is a driver swap, not a rewrite.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Decision = "allowed" | "blocked" | "redacted";
export type Mode = "redact" | "block" | "allow" | "off";
export type FailMode = "open" | "closed";

/** The canonical surfaces the dashboard manages, with the modes each can ACTUALLY
 *  do. Cursor is block/allow only — its hooks cannot rewrite text, so a "redact"
 *  mode would be a lie (CLAUDE.md, Cursor Phase K). Everything else can redact. */
export const SURFACES: { surface: string; label: string; modes: Mode[] }[] = [
  { surface: "claude-code", label: "Claude Code / Anthropic (proxy)", modes: ["redact", "block", "off"] },
  { surface: "gemini", label: "Gemini (web + Workspace + SDK)", modes: ["redact", "block", "off"] },
  { surface: "chatgpt", label: "ChatGPT (web)", modes: ["redact", "block", "off"] },
  { surface: "grok", label: "Grok (web)", modes: ["redact", "block", "off"] },
  { surface: "deepseek", label: "DeepSeek (web)", modes: ["redact", "block", "off"] },
  { surface: "openai", label: "OpenAI (SDK proxy)", modes: ["redact", "block", "off"] },
  { surface: "cursor", label: "Cursor (hooks — block/allow only)", modes: ["block", "allow"] },
];

const SURFACE_MODES = new Map(SURFACES.map((s) => [s.surface, s.modes]));

/** Which modes are valid for a surface (used to reject e.g. Cursor→redact). */
export function modesForSurface(surface: string): Mode[] {
  return SURFACE_MODES.get(surface) ?? ["redact", "block", "off"];
}

/** Map a traffic LogEntry to a dashboard surface key. Mirrors the console's
 *  display relabel (console.ts) so the two views agree. */
export function surfaceOf(entry: { method?: string; path?: string; provider?: string }): string {
  const path = String(entry.path ?? "");
  if (entry.method === "HOOK" || path.indexOf("cursor") === 0) return "cursor";
  const m = path.match(/^([a-z0-9]+)-web-extension$/);
  if (m) return m[1]; // gemini | chatgpt | grok | deepseek
  if (entry.provider === "anthropic") return "claude-code";
  return String(entry.provider ?? "unknown"); // "openai" | "gemini"
}

/** A PII type name we will accept into the event store — token-shaped only, so a
 *  raw value can never be persisted in `pii_types` even from a hostile caller. */
function sanitizePiiTypes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const v of input) {
    if (typeof v === "string" && /^[A-Z0-9_]{1,40}$/.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

const ONE = (v: unknown, allowed: string[], fallback: string): string =>
  typeof v === "string" && allowed.includes(v) ? v : fallback;

export interface EventInput {
  surface: string;
  direction?: string; // outgoing | incoming
  decision: Decision;
  pii_types?: string[];
  rule_matched?: string | null;
  latency_ms?: number | null;
  timestamp?: number;
}

export interface SurfaceConfig {
  surface: string;
  enabled: boolean;
  mode: Mode;
  pii_type_toggles: Record<string, boolean>;
  fail_mode: FailMode;
  updated_by: string;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  surface TEXT NOT NULL,
  direction TEXT NOT NULL,
  decision TEXT NOT NULL,
  pii_types TEXT NOT NULL,
  rule_matched TEXT,
  latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_surface_ts ON events(surface, timestamp);

CREATE TABLE IF NOT EXISTS surface_config (
  surface TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL,
  pii_type_toggles TEXT NOT NULL DEFAULT '{}',
  fail_mode TEXT NOT NULL DEFAULT 'closed',
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  last_login INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  admin_username TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  before_value TEXT,
  after_value TEXT
);
`;

export interface AdminStore {
  recordEvent(evt: EventInput): void;
  analytics(range: string, surface?: string, decision?: string): unknown;
  queryEvents(opts: { surface?: string; decision?: string; range?: string; limit?: number }): any[];
  eventsCsv(opts: { surface?: string; decision?: string; range?: string; limit?: number }): string;
  listSurfaces(): SurfaceConfig[];
  getSurfaceConfig(surface: string): SurfaceConfig;
  setSurfaceConfig(
    surface: string,
    patch: Partial<Pick<SurfaceConfig, "enabled" | "mode" | "pii_type_toggles" | "fail_mode">>,
    admin: string,
  ): SurfaceConfig;
  configVersion(): number;
  appendAudit(row: { admin: string; action: string; target?: string; before?: unknown; after?: unknown }): void;
  readAudit(opts: { admin?: string; from?: number; to?: number; action?: string; limit?: number }): any[];
  createUser(username: string, passwordHash: string, role?: string): void;
  getUser(username: string): any | undefined;
  touchLogin(username: string): void;
  countUsers(): number;
  close(): void;
}

const RANGE_MS: Record<string, number> = {
  today: 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
function rangeStart(range: string, now: number): number {
  return now - (RANGE_MS[range] ?? RANGE_MS["7d"]);
}

/** Open (or create) the admin store at `dbPath`. Cached per path so repeated calls
 *  in one process share one connection. `:memory:` is honored for tests. */
const CACHE = new Map<string, AdminStore>();

export function openAdminStore(dbPath: string, nowFn: () => number = Date.now): AdminStore {
  const cached = CACHE.get(dbPath);
  if (cached) return cached;

  if (dbPath !== ":memory:") {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      /* dir may exist */
    }
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  let configVersion = 0;
  const cfgCache = new Map<string, SurfaceConfig>();

  const insEvent = db.prepare(
    "INSERT INTO events(timestamp,surface,direction,decision,pii_types,rule_matched,latency_ms) VALUES(?,?,?,?,?,?,?)",
  );
  const insAudit = db.prepare(
    "INSERT INTO audit_log(timestamp,admin_username,action,target,before_value,after_value) VALUES(?,?,?,?,?,?)",
  );
  const upsertCfg = db.prepare(
    `INSERT INTO surface_config(surface,enabled,mode,pii_type_toggles,fail_mode,updated_by,updated_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(surface) DO UPDATE SET
       enabled=excluded.enabled, mode=excluded.mode, pii_type_toggles=excluded.pii_type_toggles,
       fail_mode=excluded.fail_mode, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
  );
  const getCfg = db.prepare("SELECT * FROM surface_config WHERE surface=?");

  function rowToCfg(r: any): SurfaceConfig {
    let toggles: Record<string, boolean> = {};
    try {
      toggles = JSON.parse(r.pii_type_toggles || "{}");
    } catch {
      /* keep {} */
    }
    return {
      surface: r.surface,
      enabled: !!r.enabled,
      mode: r.mode as Mode,
      pii_type_toggles: toggles,
      fail_mode: (r.fail_mode as FailMode) ?? "closed",
      updated_by: r.updated_by ?? "system",
      updated_at: Number(r.updated_at) || 0,
    };
  }

  // Seed one config row per known surface (idempotent).
  const now0 = nowFn();
  for (const s of SURFACES) {
    if (!getCfg.get(s.surface)) {
      const mode: Mode = s.modes.includes("redact") ? "redact" : "block";
      upsertCfg.run(s.surface, 1, mode, "{}", "closed", "system", now0);
    }
  }

  const store: AdminStore = {
    recordEvent(evt) {
      try {
        const ts = Number.isFinite(evt.timestamp) ? Number(evt.timestamp) : nowFn();
        const surface = typeof evt.surface === "string" && evt.surface ? evt.surface.slice(0, 60) : "unknown";
        const direction = ONE(evt.direction, ["outgoing", "incoming"], "outgoing");
        const decision = ONE(evt.decision, ["allowed", "blocked", "redacted"], "allowed") as Decision;
        const types = sanitizePiiTypes(evt.pii_types);
        const rule = types.length ? types.join(",") : null;
        const latency = Number.isFinite(evt.latency_ms as number) ? Math.max(0, Math.floor(evt.latency_ms as number)) : null;
        insEvent.run(ts, surface, direction, decision, JSON.stringify(types), rule, latency);
      } catch {
        /* never throw into a caller — analytics is best-effort */
      }
    },

    analytics(range, surface, decision) {
      const now = nowFn();
      const where: string[] = ["timestamp >= ?"];
      const args: any[] = [rangeStart(range, now)];
      if (surface) {
        where.push("surface = ?");
        args.push(surface);
      }
      if (decision) {
        where.push("decision = ?");
        args.push(decision);
      }
      const w = "WHERE " + where.join(" AND ");

      const totals = db
        .prepare(`SELECT COUNT(*) n, SUM(decision='redacted') red, SUM(decision='blocked') blk FROM events ${w}`)
        .get(...args) as any;
      const card = (r: string) =>
        (db.prepare("SELECT COUNT(*) n FROM events WHERE timestamp >= ?").get(rangeStart(r, now)) as any).n;

      // Time series bucketed by hour (today) or day (7d/30d).
      const bucketMs = range === "today" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const seriesRows = db
        .prepare(
          `SELECT (timestamp/${bucketMs})*${bucketMs} bucket, decision, COUNT(*) n FROM events ${w} GROUP BY bucket, decision ORDER BY bucket`,
        )
        .all(...args) as any[];

      // PII-type breakdown: unwrap the JSON arrays in JS (portable, no SQLite json1 dep).
      const typeCounts: Record<string, number> = {};
      for (const row of db.prepare(`SELECT pii_types FROM events ${w}`).all(...args) as any[]) {
        let arr: string[] = [];
        try {
          arr = JSON.parse(row.pii_types || "[]");
        } catch {
          /* skip */
        }
        for (const t of arr) typeCounts[t] = (typeCounts[t] ?? 0) + 1;
      }

      // Per-surface table (over the range, ignoring the surface filter).
      const perSurface = db
        .prepare(
          `SELECT surface, COUNT(*) volume,
                  SUM(decision='blocked') blocks, SUM(decision='redacted') redactions,
                  MAX(timestamp) last_seen
           FROM events WHERE timestamp >= ? GROUP BY surface`,
        )
        .all(rangeStart(range, now)) as any[];

      return {
        cards: {
          today: card("today"),
          d7: card("7d"),
          d30: card("30d"),
          redactions: Number(totals.red) || 0,
          blocks: Number(totals.blk) || 0,
          activeSurfaces: perSurface.length,
          total: Number(totals.n) || 0,
        },
        series: seriesRows.map((r) => ({ bucket: Number(r.bucket), decision: r.decision, n: Number(r.n) })),
        piiBreakdown: Object.entries(typeCounts)
          .map(([type, n]) => ({ type, n }))
          .sort((a, b) => b.n - a.n),
        perSurface: perSurface.map((r) => ({
          surface: r.surface,
          volume: Number(r.volume),
          blocks: Number(r.blocks) || 0,
          redactions: Number(r.redactions) || 0,
          lastSeen: Number(r.last_seen) || 0,
        })),
        now,
      };
    },

    queryEvents(opts) {
      const now = nowFn();
      const where: string[] = ["timestamp >= ?"];
      const args: any[] = [rangeStart(opts.range ?? "7d", now)];
      if (opts.surface) {
        where.push("surface = ?");
        args.push(opts.surface);
      }
      if (opts.decision) {
        where.push("decision = ?");
        args.push(opts.decision);
      }
      const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10000));
      return db
        .prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY timestamp DESC LIMIT ${limit}`)
        .all(...args) as any[];
    },

    eventsCsv(opts) {
      const rows = store.queryEvents(opts);
      const head = "id,timestamp,surface,direction,decision,pii_types,rule_matched,latency_ms";
      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = rows.map((r) =>
        [r.id, new Date(Number(r.timestamp)).toISOString(), r.surface, r.direction, r.decision, r.pii_types, r.rule_matched, r.latency_ms]
          .map(esc)
          .join(","),
      );
      return [head, ...lines].join("\n");
    },

    listSurfaces() {
      const rows = db.prepare("SELECT * FROM surface_config ORDER BY surface").all() as any[];
      return rows.map(rowToCfg);
    },

    getSurfaceConfig(surface) {
      if (cfgCache.has(surface)) return cfgCache.get(surface)!;
      const r = getCfg.get(surface);
      const cfg = r
        ? rowToCfg(r)
        : {
            surface,
            enabled: true,
            mode: (modesForSurface(surface).includes("redact") ? "redact" : "block") as Mode,
            pii_type_toggles: {},
            fail_mode: "closed" as FailMode,
            updated_by: "system",
            updated_at: 0,
          };
      cfgCache.set(surface, cfg);
      return cfg;
    },

    setSurfaceConfig(surface, patch, admin) {
      const before = store.getSurfaceConfig(surface);
      const next: SurfaceConfig = {
        ...before,
        ...("enabled" in patch ? { enabled: !!patch.enabled } : {}),
        ...("mode" in patch ? { mode: patch.mode as Mode } : {}),
        ...("pii_type_toggles" in patch ? { pii_type_toggles: patch.pii_type_toggles as Record<string, boolean> } : {}),
        ...("fail_mode" in patch ? { fail_mode: patch.fail_mode as FailMode } : {}),
        updated_by: admin,
        updated_at: nowFn(),
      };
      upsertCfg.run(
        surface,
        next.enabled ? 1 : 0,
        next.mode,
        JSON.stringify(next.pii_type_toggles),
        next.fail_mode,
        admin,
        next.updated_at,
      );
      insAudit.run(next.updated_at, admin, "surface_config.update", surface, JSON.stringify(before), JSON.stringify(next));
      cfgCache.set(surface, next);
      configVersion++;
      return next;
    },

    configVersion() {
      return configVersion;
    },

    appendAudit(row) {
      insAudit.run(
        nowFn(),
        row.admin,
        row.action,
        row.target ?? null,
        row.before == null ? null : JSON.stringify(row.before),
        row.after == null ? null : JSON.stringify(row.after),
      );
    },

    readAudit(opts) {
      const where: string[] = [];
      const args: any[] = [];
      if (opts.admin) {
        where.push("admin_username = ?");
        args.push(opts.admin);
      }
      if (opts.action) {
        where.push("action = ?");
        args.push(opts.action);
      }
      if (Number.isFinite(opts.from as number)) {
        where.push("timestamp >= ?");
        args.push(opts.from);
      }
      if (Number.isFinite(opts.to as number)) {
        where.push("timestamp <= ?");
        args.push(opts.to);
      }
      const w = where.length ? "WHERE " + where.join(" AND ") : "";
      const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
      return db.prepare(`SELECT * FROM audit_log ${w} ORDER BY timestamp DESC LIMIT ${limit}`).all(...args) as any[];
    },

    createUser(username, passwordHash, role = "admin") {
      db.prepare("INSERT INTO admin_users(username,password_hash,role,created_at) VALUES(?,?,?,?)").run(
        username,
        passwordHash,
        role,
        nowFn(),
      );
    },
    getUser(username) {
      return db.prepare("SELECT * FROM admin_users WHERE username=?").get(username);
    },
    touchLogin(username) {
      db.prepare("UPDATE admin_users SET last_login=? WHERE username=?").run(nowFn(), username);
    },
    countUsers() {
      return Number((db.prepare("SELECT COUNT(*) n FROM admin_users").get() as any).n) || 0;
    },
    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      CACHE.delete(dbPath);
    },
  };

  CACHE.set(dbPath, store);
  return store;
}
