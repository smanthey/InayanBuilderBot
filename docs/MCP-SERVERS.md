# MCP Servers

This repo includes MCP wrapper scripts in [`scripts/`](/Users/tatsheen/claw-repos/InayanBuilderBot/scripts) and a full verifier:

- `scripts/mcp-trigger.sh`
- `scripts/mcp-postgres.sh`
- `scripts/mcp-filesystem.sh`
- `scripts/mcp-github.sh`
- `scripts/mcp-context7.sh`
- `scripts/mcp-health-check.js`

## What Was Fixed

1. **Postgres URI password encoding**
   - `scripts/mcp-postgres.sh` URL-encodes the password before building the connection URI.
   - This prevents breakage when passwords include characters like `@`, `:`, `/`, `?`, `#`, `%`.

2. **GitHub healthcheck tolerance**
   - `scripts/mcp-github.sh --healthcheck` now returns `ok` even without token.
   - It prints a warning when `GITHUB_TOKEN` / `GITHUB_PERSONAL_ACCESS_TOKEN` is missing.
   - Runtime API calls still benefit from a token to avoid strict rate limits.

3. **Script verification coverage**
   - `scripts/mcp-health-check.js` validates:
     - MCP wrappers (`--healthcheck`)
     - GitHub MCP server startup
     - Shell syntax (`bash -n`) for all `scripts/*.sh`
     - Node syntax (`node --check`) for all `scripts/*.js` and `scripts/*.mjs`

## Run Verification

From repo root:

```bash
npm run mcp:health
```

The command exits non-zero if any check fails.

## Environment Variables

From [`.env.example`](/Users/tatsheen/claw-repos/InayanBuilderBot/.env.example):

- GitHub:
  - `GITHUB_TOKEN`
  - `GITHUB_PERSONAL_ACCESS_TOKEN`
- Postgres:
  - `POSTGRES_HOST`
  - `POSTGRES_PORT`
  - `POSTGRES_USER`
  - `POSTGRES_PASSWORD`
  - `POSTGRES_DB`

