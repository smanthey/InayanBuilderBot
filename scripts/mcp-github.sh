#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.env"
  set +a
fi

# Fallback to claw-architect env for shared local credentials when missing here.
if [[ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  CLAW_ENV_ROOT="${CLAW_ARCHITECT_ROOT:-/Users/tatsheen/claw-architect}"
  if [[ -f "$CLAW_ENV_ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$CLAW_ENV_ROOT/.env"
    set +a
  fi
fi

if [[ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" && -n "${GITHUB_TOKEN:-}" ]]; then
  export GITHUB_PERSONAL_ACCESS_TOKEN="$GITHUB_TOKEN"
fi

if [[ "${1:-}" == "--healthcheck" ]]; then
  if [[ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ]]; then
    echo "[mcp-github] warning: token missing (GITHUB_TOKEN/GITHUB_PERSONAL_ACCESS_TOKEN). Healthcheck is still OK." >&2
  fi
  echo "[mcp-github] ok"
  exit 0
fi

exec npx -y @modelcontextprotocol/server-github
