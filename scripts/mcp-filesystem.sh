#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--healthcheck" ]]; then
  echo "[mcp-filesystem] ok"
  exit 0
fi

exec npx -y @modelcontextprotocol/server-filesystem "$ROOT_DIR"
