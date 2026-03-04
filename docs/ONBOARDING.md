# Onboarding Guide (GitHub + Postgres)

This guide helps each user configure their own credentials locally for InayanBuilderBot.

## 1. Create a GitHub Token

1. Open GitHub Settings -> Developer settings -> Personal access tokens.
2. Create a fine-grained token (recommended) or classic token.
3. Minimum scopes for research/search:
   - `public_repo` (classic), or read-only repository metadata/search permissions.
4. Copy the token once and store it in your local `.env` only.

Environment keys:

- `GITHUB_TOKEN`
- `GITHUB_PERSONAL_ACCESS_TOKEN` (optional alias, can use same value)

## 2. Create a Postgres User/Database

Example SQL:

```sql
CREATE USER inayan WITH PASSWORD 'replace-with-strong-password';
CREATE DATABASE inayan_builder_bot OWNER inayan;
GRANT ALL PRIVILEGES ON DATABASE inayan_builder_bot TO inayan;
```

Set in `.env`:

- `POSTGRES_HOST`
- `POSTGRES_PORT`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`

## 3. Run Onboarding Wizard

CLI guided setup:

```bash
npm run setup:onboard
```

Web wizard:

- Open dashboard (`/`)
- Use **Onboarding Wizard** card
- Click **Save + Verify Setup**

Both flows save credentials to local `.env` and run verification.

## 4. Verification

Run:

```bash
npm run mcp:health
```

Expected:

- GitHub MCP healthcheck OK
- Postgres MCP healthcheck OK
- Script syntax checks OK

## 5. Troubleshooting

### GitHub check fails

- Confirm token value is valid and not expired.
- Confirm token has required scopes/permissions.
- Re-run: `npm run setup:onboard`.

### Postgres check fails

- Confirm host/port is reachable from your machine.
- Confirm user/password/database are correct.
- Confirm Postgres is running and accepts TCP connections.

### MCP health fails

- Run `npm install` to ensure MCP packages resolve via `npx`.
- Re-run `npm run mcp:health` and inspect failing check tails.

## Security Notes

- Never commit `.env`.
- Never share token/password values in issues/PRs.
- Dashboard and API responses mask secrets.
