#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.env"
  set +a
fi

if [[ "${1:-}" == "--healthcheck" ]]; then
  if ! command -v npx >/dev/null 2>&1; then
    echo "[mcp-trigger] npx missing" >&2
    exit 1
  fi
  echo "[mcp-trigger] ok (npx available)"
  exit 0
fi

exec npx trigger.dev@4.4.1 mcp
