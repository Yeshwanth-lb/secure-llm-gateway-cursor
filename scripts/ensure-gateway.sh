#!/usr/bin/env bash
# ensure-gateway.sh — make sure the Secure LLM Gateway is running before a
# Claude Code session starts. Idempotent + non-blocking: if the gateway is
# already healthy it exits immediately; otherwise it launches it detached and
# waits (briefly) for /healthz. Never blocks the session — always exits 0.
#
# Wired as a SessionStart hook in .claude/settings.json so routing through the
# proxy is fully automatic, with no manual `npm run dev`.

set -u

REPO="/Users/skyloindia/Desktop/MCP-PROXY"
HOST="127.0.0.1"
PORT="${GATEWAY_PORT:-8000}"
URL="http://${HOST}:${PORT}/healthz"
ENTRY="${REPO}/secure-llm-gateway.ts"
LOG="/tmp/secure-llm-gateway.log"

if curl -sf "$URL" >/dev/null 2>&1; then
  echo "secure-llm-gateway: already running on ${HOST}:${PORT}"
  exit 0
fi

# find node (login shells vary); fall back to PATH
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "secure-llm-gateway: node not found on PATH — cannot auto-start" >&2
  exit 0
fi

# launch detached so it outlives this hook process
GATEWAY_PORT="$PORT" nohup "$NODE" --experimental-strip-types "$ENTRY" >"$LOG" 2>&1 &
disown 2>/dev/null || true

# wait up to ~10s for health
for _ in $(seq 1 20); do
  if curl -sf "$URL" >/dev/null 2>&1; then
    echo "secure-llm-gateway: started on ${HOST}:${PORT} (log: ${LOG})"
    exit 0
  fi
  sleep 0.5
done

echo "secure-llm-gateway: did NOT become healthy — check ${LOG}" >&2
exit 0
