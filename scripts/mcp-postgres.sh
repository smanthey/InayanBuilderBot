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
if [[ -z "${POSTGRES_PASSWORD:-${CLAW_DB_PASSWORD:-}}" ]]; then
  CLAW_ENV_ROOT="${CLAW_ARCHITECT_ROOT:-/Users/tatsheen/claw-architect}"
  if [[ -f "$CLAW_ENV_ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$CLAW_ENV_ROOT/.env"
    set +a
  fi
fi

HOST="${POSTGRES_HOST:-${CLAW_DB_HOST:-127.0.0.1}}"
PORT="${POSTGRES_PORT:-${CLAW_DB_PORT:-5432}}"
USER="${POSTGRES_USER:-${CLAW_DB_USER:-postgres}}"
PASS="${POSTGRES_PASSWORD:-${CLAW_DB_PASSWORD:-}}"
DB="${POSTGRES_DB:-${CLAW_DB_NAME:-postgres}}"

if [[ "${1:-}" == "--healthcheck" ]]; then
  if [[ -z "$PASS" ]]; then
    echo "[mcp-postgres] warning: password missing (POSTGRES_PASSWORD/CLAW_DB_PASSWORD)" >&2
  fi
  echo "[mcp-postgres] ok host=$HOST port=$PORT db=$DB user=$USER"
  exit 0
fi

if [[ -z "$PASS" ]]; then
  echo "[mcp-postgres] missing POSTGRES_PASSWORD/CLAW_DB_PASSWORD" >&2
  exit 1
fi

# URL-encode password so special chars (@ : / % # ?) are safe in URI.
PASS_ENC="$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$PASS")"
URI="postgresql://${USER}:${PASS_ENC}@${HOST}:${PORT}/${DB}"

exec npx -y @modelcontextprotocol/server-postgres "$URI"
