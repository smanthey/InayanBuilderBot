# Update Notes

## 2026-03-04 (Onboarding Wizard + Versioned Benchmark Refresh)

### Guided onboarding with verification

- Added setup endpoints:
  - `GET /api/v1/setup/status`
  - `POST /api/v1/setup/onboard`
- Added dashboard onboarding wizard card in `public/index.html`:
  - generate `BUILDERBOT_API_KEY`
  - input `GITHUB_TOKEN`
  - input `POSTGRES_HOST/PORT/USER/PASSWORD/DB`
  - save local `.env`
  - run checks (GitHub API, Postgres TCP, `npm run mcp:health`)
- Added CLI fallback:
  - `scripts/setup-onboard.mjs`
  - `npm run setup:onboard`
- Added docs:
  - `docs/ONBOARDING.md`

Security behavior:

- Secrets are persisted only to local `.env`.
- Setup responses and UI status use masked secret values.
- No token/password values are logged.

### Research refresh and benchmark implementation

- Re-ran GitHub + Reddit research signal pass.
- Refreshed benchmark metadata in `data/builtin-repo-index.json`:
  - updated stars/forks/pushed timestamps
  - added latest release tags where available
- Updated `docs/RESEARCH_AND_BENCHMARKS.md` with:
  - “best versions to benchmark” table
  - latest Reddit trend insights for viral OSS execution.

---

## 2026-03-04 (MCP Reliability + Script Verification Hardening)

### Summary

Implemented MCP reliability updates so local setup is resilient and verification is one command.

### Changes shipped

- Added MCP wrapper scripts:
  - `scripts/mcp-trigger.sh`
  - `scripts/mcp-postgres.sh`
  - `scripts/mcp-filesystem.sh`
  - `scripts/mcp-github.sh`
  - `scripts/mcp-context7.sh`
  - `scripts/mcp-health-check.js`
- Added `npm run mcp:health` in `package.json`.
- Added docs: `docs/MCP-SERVERS.md`.

### Fixes requested and delivered

1. **URL-encode Postgres password in URI**
   - `scripts/mcp-postgres.sh` now uses `encodeURIComponent` before constructing `postgresql://...`.
   - Prevents auth failures when password contains reserved URI characters.

2. **GitHub healthcheck tolerant when token missing**
   - `scripts/mcp-github.sh --healthcheck` now returns OK with warning if token is missing.
   - Keeps local bootstrap and CI checks green while still signaling degraded GitHub API limits.

3. **Verify all scripts**
   - `scripts/mcp-health-check.js` now runs:
     - MCP wrapper `--healthcheck` checks
     - GitHub MCP boot probe
     - shell syntax checks for all `scripts/*.sh`
     - Node syntax checks for all `scripts/*.js` and `scripts/*.mjs`

### Benchmark/index refresh

- Updated `data/builtin-repo-index.json` with additional MCP ecosystem leaders from latest GitHub search:
  - `punkpeye/awesome-mcp-servers`
  - `upstash/context7`
  - `microsoft/playwright-mcp`
  - `github/github-mcp-server`
  - `PrefectHQ/fastmcp`

---

## 2026-03-04 (Viral OSS Research & Benchmark Update)

### Research-Driven Benchmark Index and Documentation

To support **going viral** and qualifying for open source programs (e.g. Claude for Open Source), we used **Reddit** and **GitHub** research to identify top ideas and repos, then updated the built-in index and documentation.

- **Viral OSS benchmarks added to `data/builtin-repo-index.json`**  
  Curated entries from Reddit and GitHub research:
  - **anthropics/claude-code** (71.7k+ stars) — official agentic terminal coding tool
  - **cline/cline** (58.6k+ stars) — fastest-growing AI OSS on GitHub 2025, VS Code agent with MCP
  - **mcp/ChromeDevTools** (27.1k+ stars) — Chrome DevTools MCP for browser automation
  - **BeehiveInnovations/zen-mcp-server** (1.4k+ stars) — multi-model MCP (Claude, Gemini, O3, OpenRouter, Ollama)
  - **nanobot-ai/nanobot** (1.1k+ stars) — framework for building MCP agents

- **New doc: `docs/RESEARCH_AND_BENCHMARKS.md`**  
  Professional write-up covering:
  - Research sources and methods (GitHub repo/issue search, Reddit fallback chain and ranking)
  - Viral OSS benchmark table with star counts and “why it matters”
  - Reddit-derived patterns for going viral (problem statement, one-command setup, creator engagement, differentiators, license)
  - How InayanBuilderBot uses research (scout, benchmark, GitHub/Reddit stages, chat grounding)
  - Steps to update the benchmark index and references

- **Index metadata**  
  `builtin-repo-index.json` notes now state that it includes viral OSS benchmarks from Reddit/GitHub research for builder-bot qualification and community trends.

Scout and pipeline runs now prioritize these benchmarks alongside existing dashboard/chat UI repos. No API or schema changes; existing endpoints and pipeline behavior remain the same.

---

## 2026-03-04

### GitHub + Reddit Intelligence Fully Included

- Added built-in GitHub research system:
  - repo search intelligence (`/search/repositories`)
  - issue/forum answer intelligence (`/search/issues`)
  - code snippet extraction from fenced markdown blocks
- Added endpoints:
  - `GET /api/v1/github/capabilities`
  - `POST /api/v1/github/research`
- Added pipeline integration:
  - `runGithubResearch` toggle (default `true`) in `/api/v1/masterpiece/pipeline/run`
  - `github_research` stage output and blueprint `githubAnswerTop` summary

### Reddit Systems Ported In-Natively (No OpenClaw Required)

- Added built-in Reddit research engine to `src/index.js` using OpenClaw-parity behaviors:
  - source fallback order: `reddit_top`, `old_reddit_top`, `hot`, `new`, `rss`
  - auth profile rotation via `REDDIT_AUTH_PROFILES` or `REDDIT_USER_AGENTS` + `REDDIT_ACCESS_TOKENS`
  - ranking with engagement, freshness, quality boosts, and query-term matching
- Added endpoints:
  - `GET /api/v1/reddit/capabilities`
  - `POST /api/v1/reddit/search`
- Added pipeline integration:
  - `runRedditResearch` toggle (default `true`) in `/api/v1/masterpiece/pipeline/run`
  - `reddit_research` stage output and blueprint `redditSignalTop` summary
- Added environment options in `.env.example`:
  - `REDDIT_USER_AGENT`
  - `REDDIT_DEFAULT_SUBREDDITS`
  - `REDDIT_REQUEST_TIMEOUT_MS`
  - optional profile settings (`REDDIT_AUTH_PROFILES`, `REDDIT_USER_AGENTS`, `REDDIT_ACCESS_TOKENS`)

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
