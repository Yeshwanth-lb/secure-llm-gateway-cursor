#!/usr/bin/env bash
# Deprecated wrapper — delegates to claude-session-hook.mjs (start + fail-closed health).
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "secure-llm-gateway: node not found on PATH" >&2
  exit 2
fi
exec "$NODE" "${SCRIPT_DIR}/claude-session-hook.mjs"
