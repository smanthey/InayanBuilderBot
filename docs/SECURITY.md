# Security Model

## Controls Implemented

1. HTTP hardening headers with `helmet`
2. Request rate limiting (`express-rate-limit`)
3. Input validation via `zod`
4. Optional API key auth for API endpoints
5. CORS allowlist via `ALLOWED_ORIGIN`
6. Sensitive file ignore strategy in `.gitignore`
7. Repo secret scanner script (`npm run security:check`)

## Sensitive Data Policy

- Never commit real tokens, keys, passwords, or connection strings.
- Store runtime secrets in environment variables.
- Commit only placeholders via `.env.example`.

## Operational Security Checklist

- Use strong random `BUILDERBOT_API_KEY`.
- Restrict `ALLOWED_ORIGIN` in production.
- Put behind TLS reverse proxy.
- Run `npm run security:check` before each push.
- Rotate API keys periodically.
