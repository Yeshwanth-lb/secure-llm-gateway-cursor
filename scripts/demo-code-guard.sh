#!/usr/bin/env bash
# =============================================================================
# CODE GUARD (Checkpoint 2b) — live demo
# -----------------------------------------------------------------------------
# Shows the whole loop end-to-end against the REAL gateway endpoints:
#
#   1. Agent writes vulnerable code  -> SCAN hook POSTs the file to
#      POST /action-guard/scan        (Tier-1 patterns || Tier-2 LLM, merged)
#   2. Findings ACCUMULATE per conversation_id (scan fires per-edit)
#   3. Turn ends -> STOP hook drains  GET /action-guard/pending
#      -> builds the "regenerate securely" follow-up, then CLEARS (read-once)
#
# Runs a THROWAWAY gateway on its own port with the guard ON and Tier-2 OFF,
# so it is deterministic, offline, and never touches your live :8001 service.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."          # repo root
PORT="${DEMO_PORT:-8010}"
BASE="http://127.0.0.1:${PORT}"
CONV="demo-turn-$$"              # a fake conversation/session id for this run
WORK="$(mktemp -d)"
GW_PID=""

cleanup() {
  [ -n "$GW_PID" ] && kill "$GW_PID" 2>/dev/null || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

hr() { printf '\n\033[1;36m── %s\033[0m\n' "$1"; }
say() { printf '\033[0;90m%s\033[0m\n' "$1"; }

# -----------------------------------------------------------------------------
hr "1/5  Start a throwaway gateway with Code Guard ON (Tier-2 OFF)"
say "GATEWAY_ACTION_GUARD=on  GATEWAY_ACTION_GUARD_TIER2=off  GATEWAY_PORT=$PORT"
GATEWAY_ACTION_GUARD=on \
GATEWAY_ACTION_GUARD_TIER2=off \
GATEWAY_HOST=127.0.0.1 \
GATEWAY_PORT="$PORT" \
  node --experimental-strip-types secure-llm-gateway.ts >/dev/null 2>&1 &
GW_PID=$!

# wait for /healthz
for _ in $(seq 1 40); do
  if curl -fs -m 1 "$BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -fs -m 2 "$BASE/healthz" >/dev/null || { echo "gateway did not come up"; exit 1; }
say "gateway up (pid $GW_PID)"

# -----------------------------------------------------------------------------
hr "2/5  The agent writes vulnerable code (two files this 'turn')"
cat > "$WORK/users.js" <<'EOF'
function getUser(db, id) {
  // vulnerable: SQL built by interpolation (not parameterized)
  const q = `SELECT * FROM users WHERE id = ${id}`;
  return db.query(q);
}
EOF

cat > "$WORK/run.py" <<'EOF'
import hashlib, os
def handle(cmd, payload):
    os.system("backup.sh " + cmd)          # command injection
    token = eval(payload)                   # dynamic eval on input
    return hashlib.md5(token).hexdigest()   # weak crypto
EOF
say "wrote users.js (SQL concat) and run.py (cmd-injection + eval + md5)"

# -----------------------------------------------------------------------------
hr "3/5  SCAN hook fires per edit -> POST /action-guard/scan (findings accumulate)"
for f in users.js run.py; do
  say "scan: $f"
  curl -s -X POST "$BASE/action-guard/scan" \
    -H 'content-type: application/json' \
    --data "$(node -e '
      const fs=require("fs");
      process.stdout.write(JSON.stringify({
        conversation_id: process.argv[1],
        file_path: process.argv[2],
        content: fs.readFileSync(process.argv[3],"utf8"),
        surface: "claude-code"
      }));' "$CONV" "$f" "$WORK/$f")" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const j=JSON.parse(s);
        for(const x of j.findings) console.log(`   • tier${x.tier} [${x.category}]${x.line?" line "+x.line:""}`);
      });'
done

# -----------------------------------------------------------------------------
hr "4/5  Turn ends -> STOP hook drains GET /action-guard/pending"
say "this is the exact 'regenerate securely' message the agent is handed back:"
echo
curl -s "$BASE/action-guard/pending?conversation_id=$CONV" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);
    console.log("\x1b[1;33m"+j.message+"\x1b[0m");
    console.log(`\n(count=${j.count}, loop_limit=${j.loop_limit}, cap_behavior=${j.cap_behavior})`);
  });'

# -----------------------------------------------------------------------------
hr "5/5  Read-once: a second drain returns nothing (findings were cleared)"
curl -s "$BASE/action-guard/pending?conversation_id=$CONV" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);
    console.log(`count=${j.count}  -> the store cleared on the first drain (no loop-spin)`);
  });'

hr "done"
say "fail-safe proof: the vulnerable files are still on disk — Code Guard never"
say "blocks an edit; it loops the AGENT to regenerate. Nothing was destroyed."
