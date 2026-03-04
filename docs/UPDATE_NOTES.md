# Update Notes

## 2026-03-04

### No-OpenClaw Default + Curated External Repo Index

- `EXTERNAL_INDEXING_MODE` default is now `builtin`.
- Added built-in curated repo index file: `data/builtin-repo-index.json`.
- Scout/pipeline now use curated external repos first, then GitHub API fallback when needed.
- Scout scoring now prioritizes proven dashboard/chat UI signals and excludes framework-only candidates more aggressively.
- Added automation helpers:
  - `scripts/bootstrap-local.mjs`
  - `npm run setup:auto`
  - `npm run start:auto`
  - `npm run dev:auto`
  - `launch.command` (macOS double-click startup)

### Chat Provider Compatibility Update

`/api/v1/chat/reply` now supports natural provider aliases so agent prompts can use common names:

- `claude` maps to `anthropic`
- `google` maps to `gemini`

### Replit-Quality UX/Operations Upgrade

- Added `GET /api/v1/chat/providers` for runtime provider capability visibility.
- Added dashboard controls for:
  - provider selection
  - optional model override
  - temperature input
  - one-click provider status view
- Health endpoint now includes `chat_provider_count`.

### Full Upgrade Bundle (Streaming, Sessions, Deploy, Metrics, E2E)

- Added `POST /api/v1/chat/reply/stream` (SSE) with `start`, `chunk`, `done`, `error` events.
- Added persistent multi-conversation chat sessions:
  - `GET /api/v1/chat/sessions`
  - `GET /api/v1/chat/sessions/:sessionId`
  - Optional `sessionId` in chat requests.
- Added provider latency/cost/success tracking and auto-routing improvements in `provider=auto`.
- Added one-click deployment assets:
  - `Dockerfile`
  - `docker-compose.yml`
  - `.dockerignore`
- Added end-to-end smoke test:
  - `tests/e2e.smoke.test.js`

### Advanced Indexing Integration Included

- Added built-in advanced indexing stage into pipeline execution when `runExternal=true`.
- Added mode switch: `EXTERNAL_INDEXING_MODE`:
  - `auto` (OpenClaw if present, else built-in)
  - `builtin` (always in-app indexing)
  - `openclaw` (force external stack)
- This makes advanced indexing usable out-of-box without extra MCP setup.

### OpenClaw/MCP Parity Endpoints

- Added dedicated indexing bridge endpoints:
  - `GET /api/v1/indexing/capabilities`
  - `POST /api/v1/indexing/sync`
  - `POST /api/v1/indexing/readiness`
  - `POST /api/v1/indexing/dashboard-scout`
- These execute OpenClaw scripts when available and report clear capability status.

### Environment Alias Support

Additional environment variable aliases are now accepted:

- Claude:
  - `CLAUDE_API_KEY` (alias of `ANTHROPIC_API_KEY`)
  - `CLAUDE_CHAT_MODEL` (alias of `ANTHROPIC_CHAT_MODEL`)
- Google Gemini:
  - `GOOGLE_API_KEY`
  - `GOOGLE_GENAI_API_KEY`
  - `GOOGLE_CHAT_MODEL` (alias of `GEMINI_CHAT_MODEL`)

### Validation

Validated after patch:

- `npm test`
- `npm run lint`
- `npm run security:check`

### Commit Reference

- `a4ee9c6` — Add Claude/Google provider aliases for model-backed chat
