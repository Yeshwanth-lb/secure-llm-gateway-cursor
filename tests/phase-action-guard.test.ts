// ===== PHASE ACTION-GUARD (Code Guard) TESTS — Checkpoint 2b =================
// Code Guard = scan the CODE an AI agent just wrote and, if it is insecure, loop
// the agent to regenerate securely (Semgrep-Guardian mechanism, zero-dep). This
// is the "correct" half of Action Guard; the "prevent" half (Command Guard) is
// already shipped in tests/phase-command-guard.test.ts.
//
// Two tiers, run UNCONDITIONALLY in parallel and merged (spec §3): Tier 1 is a
// deterministic pattern matcher (string-concat SQL, eval, exec-with-input, weak
// crypto, hardcoded secrets); Tier 2 is an LLM that catches what patterns can't
// (a missing-auth route). Tier 2 is NEVER gated behind a clean Tier 1 — the whole
// point is that Tier 1 is structurally blind to Tier-2 bugs.
//
// Posture is fail-SAFE (NOT fail-closed like Command Guard): a scan error never
// blocks — there is nothing to block, the code is already on disk. The guarantee
// is the regenerate follow-up + a loud audit row, not a hard wall.
//
// The three phase-gate e2e (through the REAL gateway):
//   happy   — enabled: a SQL-concat file scanned -> a sql_injection finding lands
//             in the per-conversation accumulator; /pending returns it once then
//             CLEARS (a second /pending is empty).
//   failure — guard OFF -> /scan returns no findings (feature disabled); and an
//             unreadable body -> 200 with empty findings, never a throw/block.
//   edge    — Tier 1 alone MISSES a missing-auth route, but /scan with Tier 2 on
//             still records it (proves the two tiers run independently).
// Plus: the Tier-1 unit matrix, the scanCode merge/fail-safe unit, the accumulator
// unit, and a hook spawn test proving the Claude Code Stop hook honours
// stop_hook_active (exits 0, no /pending call — the billing-safety requirement).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createGatewayServer,
  securityLog,
  scanTier1,
  scanCode,
  setCodeScanner,
  resetCodeScanner,
  actionGuardStore,
  type Finding,
} from "../secure-llm-gateway.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A file whose naive SQL query is built by string concatenation (Tier-1 catch).
const SQL_CONCAT = `
export function getUser(db, id) {
  const q = "SELECT * FROM users WHERE id = " + id;
  return db.query(q);
}`;

// A route with NO authorization check. Tier 1 is structurally blind to this;
// only Tier 2 (the LLM) recognises the missing guard.
const MISSING_AUTH = `
app.get("/api/users/:id", (req, res) => {
  const user = db.users.find(req.params.id);
  res.json(user);
});`;

const CLEAN = `
export function add(a, b) {
  return a + b;
}`;

// ---------------------------------------------------------------------------
// UNIT — scanTier1 (deterministic)
// ---------------------------------------------------------------------------
test("tier1: string-concat / interpolated SQL is flagged sql_injection", () => {
  for (const c of [
    'const q = "SELECT * FROM users WHERE id = " + id;',
    "const q = `SELECT * FROM t WHERE name = '${name}'`;",
    'cur.execute(f"SELECT * FROM users WHERE id = {uid}")',
  ]) {
    const f = scanTier1(c);
    assert.ok(f.some((x) => x.category === "sql_injection"), c);
    assert.ok(f.every((x) => x.tier === 1));
  }
});

test("tier1: eval / exec-with-input / weak crypto / hardcoded secret are flagged", () => {
  assert.ok(scanTier1('eval(userInput)').some((f) => f.category === "dangerous_eval"));
  assert.ok(scanTier1('child_process.exec("ls " + dir)').some((f) => f.category === "command_injection"));
  assert.ok(scanTier1('crypto.createHash("md5")').some((f) => f.category === "weak_crypto"));
  assert.ok(scanTier1('const apiKey = "sk-live-abcdef123456";').some((f) => f.category === "hardcoded_secret"));
});

test("tier1: clean code yields nothing, and a missing-auth route is a BLIND SPOT", () => {
  assert.deepEqual(scanTier1(CLEAN), []);
  // The load-bearing property: Tier 1 does NOT (and cannot) flag missing auth.
  assert.equal(scanTier1(MISSING_AUTH).some((f) => f.category === "missing_auth"), false);
});

test("tier1: a finding carries a 1-indexed line number", () => {
  const f = scanTier1(SQL_CONCAT).find((x) => x.category === "sql_injection")!;
  assert.ok(f, "sql finding present");
  assert.equal(f.line, 3); // the concat is on line 3 of SQL_CONCAT
});

// ---------------------------------------------------------------------------
// UNIT — scanCode (Tier 1 || Tier 2, merged, fail-safe)
// ---------------------------------------------------------------------------
test("scanCode: BOTH tiers run and findings merge (Tier 2 not gated on Tier 1)", async () => {
  // Tier 1 finds the SQL concat; the injected Tier 2 finds the missing auth the
  // patterns can't. The merged result must contain BOTH.
  const tier2: Finding[] = [{ tier: 2, category: "missing_auth", message: "Route has no authorization check." }];
  const merged = await scanCode(SQL_CONCAT + MISSING_AUTH, {
    tier2Enabled: true,
    classify: async () => tier2,
  });
  assert.ok(merged.some((f) => f.tier === 1 && f.category === "sql_injection"));
  assert.ok(merged.some((f) => f.tier === 2 && f.category === "missing_auth"));
});

test("scanCode: a Tier-2 that throws or times out degrades to Tier-1 only (never throws)", async () => {
  const merged = await scanCode(SQL_CONCAT, {
    tier2Enabled: true,
    classify: async () => {
      throw new Error("upstream 500");
    },
  });
  // fail-SAFE: still returns Tier-1 findings, no exception
  assert.ok(merged.some((f) => f.category === "sql_injection"));
  assert.ok(merged.every((f) => f.tier === 1));
});

test("scanCode: Tier 2 off -> only Tier 1 runs even when a classifier is present", async () => {
  const spy = { called: false };
  const merged = await scanCode(MISSING_AUTH, {
    tier2Enabled: false,
    classify: async () => {
      spy.called = true;
      return [{ tier: 2, category: "missing_auth", message: "x" }];
    },
  });
  assert.equal(spy.called, false);
  assert.deepEqual(merged, []); // Tier 1 is blind to missing auth
});

// ---------------------------------------------------------------------------
// UNIT — accumulator store
// ---------------------------------------------------------------------------
test("store: findings accumulate per conversation and take() returns then CLEARS", () => {
  actionGuardStore.clear();
  const conv = "conv-1";
  actionGuardStore.append(conv, [{ tier: 1, category: "sql_injection", message: "a", line: 1 }]);
  actionGuardStore.append(conv, [{ tier: 2, category: "missing_auth", message: "b" }]);
  assert.equal(actionGuardStore.size(conv), 2);
  const taken = actionGuardStore.take(conv);
  assert.equal(taken.length, 2);
  // cleared on read (the stop hook reads once per turn)
  assert.equal(actionGuardStore.size(conv), 0);
  assert.deepEqual(actionGuardStore.take(conv), []);
});

test("store: identical findings from a re-scan are de-duplicated; conversations are isolated", () => {
  actionGuardStore.clear();
  const dup: Finding = { tier: 1, category: "sql_injection", message: "same", line: 3 };
  actionGuardStore.append("c1", [dup]);
  actionGuardStore.append("c1", [dup]); // re-scan of the same file, same finding
  assert.equal(actionGuardStore.size("c1"), 1);
  actionGuardStore.append("c2", [dup]);
  assert.equal(actionGuardStore.size("c2"), 1); // separate conversation untouched
  assert.equal(actionGuardStore.size("c1"), 1);
});

// ---------------------------------------------------------------------------
// E2E — through the real gateway
// ---------------------------------------------------------------------------
async function withGateway(
  overrides: Record<string, unknown>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createGatewayServer(overrides);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}

async function postScan(base: string, body: unknown) {
  const res = await fetch(`${base}/action-guard/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
async function getPending(base: string, conv: string) {
  const res = await fetch(`${base}/action-guard/pending?conversation_id=${encodeURIComponent(conv)}`);
  return { status: res.status, json: (await res.json()) as any };
}

test("e2e happy: enabled -> SQL-concat scanned lands a finding; /pending returns then clears", async () => {
  securityLog.clear();
  actionGuardStore.clear();
  await withGateway({ actionGuardEnabled: true, actionGuardTier2: false }, async (base) => {
    const conv = "turn-happy";
    const scan = await postScan(base, {
      conversation_id: conv,
      file_path: "src/db.ts",
      content: SQL_CONCAT,
      surface: "claude-code",
    });
    assert.equal(scan.status, 200);
    assert.ok(Array.isArray(scan.json.findings));
    assert.ok(scan.json.findings.some((f: Finding) => f.category === "sql_injection"));

    // the stop hook reads pending: findings + a regenerate message, then cleared
    const p1 = await getPending(base, conv);
    assert.ok(p1.json.count >= 1);
    assert.ok(p1.json.findings.some((f: Finding) => f.category === "sql_injection"));
    assert.ok(typeof p1.json.message === "string" && /regenerate/i.test(p1.json.message));

    const p2 = await getPending(base, conv);
    assert.equal(p2.json.count, 0);
    assert.deepEqual(p2.json.findings, []);
  });
});

test("e2e failure: guard OFF -> no findings; unreadable body -> 200 empty, never blocks", async () => {
  // guard OFF: a clearly-insecure file still returns nothing (feature disabled)
  await withGateway({ actionGuardEnabled: false }, async (base) => {
    const off = await postScan(base, { conversation_id: "x", file_path: "a.ts", content: SQL_CONCAT });
    assert.equal(off.status, 200);
    assert.deepEqual(off.json.findings, []);
  });
  // enabled but unreadable body: fail-SAFE -> 200 empty findings, no throw/500
  await withGateway({ actionGuardEnabled: true, actionGuardTier2: false }, async (base) => {
    const bad = await postScan(base, "{ not json");
    assert.equal(bad.status, 200);
    assert.deepEqual(bad.json.findings, []);
  });
});

test("e2e edge: Tier 1 misses a missing-auth route, but Tier 2 records it via /scan", async () => {
  securityLog.clear();
  actionGuardStore.clear();
  // Install a deterministic Tier-2 stub (no live model) that flags missing auth.
  setCodeScanner(async (content: string) =>
    /app\.(get|post|put|delete)\(/.test(content) && !/req\.(user|auth)|isAuthed|requireAuth/.test(content)
      ? [{ tier: 2 as const, category: "missing_auth", message: "Route exposes data with no authorization check." }]
      : [],
  );
  try {
    await withGateway({ actionGuardEnabled: true, actionGuardTier2: true }, async (base) => {
      const conv = "turn-edge";
      const scan = await postScan(base, {
        conversation_id: conv,
        file_path: "src/route.ts",
        content: MISSING_AUTH,
        surface: "claude-code",
      });
      // Tier 1 found nothing here; Tier 2 supplied the finding.
      assert.ok(scan.json.findings.some((f: Finding) => f.tier === 2 && f.category === "missing_auth"));
      assert.equal(scan.json.findings.some((f: Finding) => f.category === "sql_injection"), false);

      // it accumulated + a loud admin audit row was written (fail-safe = audit is the guarantee)
      const p = await getPending(base, conv);
      assert.ok(p.json.findings.some((f: Finding) => f.category === "missing_auth"));
      const row = securityLog.recent(20).find((r) => (r as any).kind === "action-guard");
      assert.ok(row, "an action-guard audit row was written");
      assert.equal((row as any).filePath, "src/route.ts");
    });
  } finally {
    resetCodeScanner();
  }
});

// ---------------------------------------------------------------------------
// HOOK — Claude Code Stop hook honours stop_hook_active (billing-safety)
// ---------------------------------------------------------------------------
test("hook: Claude Code Stop hook exits 0 with NO output when stop_hook_active is true", async () => {
  const hook = join(REPO_ROOT, "scripts", "claude-code-action-stop-hook.mjs");
  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [hook], {
      // Point at a dead port: if the guard were to call /pending it would error.
      // With stop_hook_active:true it must SHORT-CIRCUIT before any call.
      env: { ...process.env, GATEWAY_HOST: "127.0.0.1", GATEWAY_PORT: "59" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.write(JSON.stringify({ stop_hook_active: true, session_id: "s1" }));
    child.stdin.end();
  });
  assert.equal(result.code, 0, "stop hook must exit 0");
  assert.equal(result.out.trim(), "", "must produce NO block decision when already looping");
});

test("hook: Claude Code Stop hook fails SAFE (exit 0, no block) when the gateway is unreachable", async () => {
  const hook = join(REPO_ROOT, "scripts", "claude-code-action-stop-hook.mjs");
  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [hook], {
      env: { ...process.env, GATEWAY_HOST: "127.0.0.1", GATEWAY_PORT: "59" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.write(JSON.stringify({ stop_hook_active: false, session_id: "s2" }));
    child.stdin.end();
  });
  // Code Guard is observational: a dead gateway must NOT block the turn.
  assert.equal(result.code, 0, "stop hook must never block on error");
  assert.equal(result.out.trim(), "", "no block decision when findings can't be read");
});
