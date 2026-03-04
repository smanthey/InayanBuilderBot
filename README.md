# InayanBuilderBot

**InayanBuilderBot is the complete Masterpiece Agent + Chat Tool.**

Dedicated to **Suro Jason Inaya**. Built for him personally.

[![CI](https://github.com/smanthey/InayanBuilderBot/actions/workflows/ci.yml/badge.svg)](https://github.com/smanthey/InayanBuilderBot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

## Complete Product Scope

This is a robust, working system, not a lite demo. It includes:

1. Masterpiece pipeline orchestration endpoint
2. OSS repo scout with quality scoring
3. Benchmark/compare engine
4. Masterpiece blueprint generator
5. Chat tool with context-aware guidance
6. Persistent run artifacts and history
7. Security hardening + CI + secret checks

## Endpoints

- `POST /api/v1/masterpiece/pipeline/run` (full robust workflow)
- `POST /api/v1/scout/run`
- `POST /api/v1/benchmark/run`
- `POST /api/v1/masterpiece/build`
- `GET /api/v1/indexing/capabilities`
- `POST /api/v1/indexing/sync`
- `POST /api/v1/indexing/readiness`
- `POST /api/v1/indexing/dashboard-scout`
- `GET /api/v1/github/capabilities`
- `POST /api/v1/github/research`
- `GET /api/v1/reddit/capabilities`
- `POST /api/v1/reddit/search`
- `POST /api/v1/chat/reply`
- `POST /api/v1/chat/reply/stream` (SSE)
- `GET /api/v1/chat/providers`
- `GET /api/v1/chat/history`
- `GET /api/v1/chat/sessions`
- `GET /api/v1/chat/sessions/:sessionId`
- `GET /api/v1/runs`
- `GET /health`

## Robust Pipeline: What It Executes

`/api/v1/masterpiece/pipeline/run` performs:

1. Scout candidate repos from GitHub (or seed repos)
2. Exclude low-signal framework-only repos
3. Benchmark and compare top candidates
4. Advanced indexing integration (included by default):
   - Built-in indexing + benchmark refinement inside InayanBuilderBot (no extra MCP tooling required)
   - Curated external repo index focused on proven dashboard/chat UI stacks
   - Optional OpenClaw external indexing/scout stack when available:
   - `index:sync:agent`
   - `repo:readiness:pulse`
   - `dashboard:repo:scout`
5. Produce a final build blueprint based on selected top repos
6. Run built-in GitHub research stage (repo + issue/code-answer intelligence)
7. Run built-in Reddit research stage (fallback chain + ranked signals)
8. Persist artifacts to `.data/runs.json`

## Install

```bash
git clone https://github.com/smanthey/InayanBuilderBot.git
cd InayanBuilderBot
npm install
npm run setup:auto
```

No-terminal shortcut on macOS: double-click `launch.command`.

## Run From GitHub (Verified)

This project is validated from a clean GitHub clone.

Verified flow:

```bash
git clone https://github.com/smanthey/InayanBuilderBot.git
cd InayanBuilderBot
npm ci
npm run lint
npm run security:check
npm test
npm run setup:auto
npm run dev:auto
```

Validation note:
- Fresh-clone run path was re-validated on March 4, 2026.

## Configure

Set in `.env`:

- `BUILDERBOT_API_KEY` (recommended for production)
- `ALLOWED_ORIGIN`
- `GITHUB_TOKEN` (recommended for GitHub API limit)
- `CLAW_ARCHITECT_ROOT` (optional, default `/Users/tatsheen/claw-architect`)
- `EXTERNAL_INDEXING_MODE`:
  - `builtin` (default): use built-in curated repo index + advanced indexing
  - `auto`: use OpenClaw if available, otherwise built-in advanced indexing
  - `openclaw`: require OpenClaw external stack
- one or more provider keys for live AI chat:
  - `OPENAI_API_KEY`
  - `DEEPSEEK_API_KEY`
  - `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`)
  - `GEMINI_API_KEY` (or `GOOGLE_API_KEY` / `GOOGLE_GENAI_API_KEY`)
- optional model overrides:
  - `OPENAI_CHAT_MODEL`
  - `DEEPSEEK_CHAT_MODEL`
  - `ANTHROPIC_CHAT_MODEL` (or `CLAUDE_CHAT_MODEL`)
  - `GEMINI_CHAT_MODEL` (or `GOOGLE_CHAT_MODEL`)
- Reddit intelligence settings (built-in, OpenClaw-free):
  - `REDDIT_USER_AGENT`
  - `REDDIT_DEFAULT_SUBREDDITS`
  - `REDDIT_REQUEST_TIMEOUT_MS`
  - optional auth profile inputs:
    - `REDDIT_AUTH_PROFILES` (JSON array)
    - `REDDIT_USER_AGENTS` / `REDDIT_ACCESS_TOKENS` (CSV fallback)

## Reddit Research Intelligence

The new system includes the Reddit capability set previously handled in OpenClaw scripts:

- source fallback chain: `reddit_top -> old_reddit_top -> hot -> new -> rss`
- auth profile rotation (when configured)
- ranked scoring with engagement + freshness + query-term matching
- pipeline integration (`reddit_research` stage in `/api/v1/masterpiece/pipeline/run`)

Endpoints:

- `GET /api/v1/reddit/capabilities`
- `POST /api/v1/reddit/search`

Example request:

```json
{
  "query": "dashboard chat ui open source llm",
  "subreddits": ["AI_Agents", "LocalLLaMA", "webdev"],
  "limitPerSubreddit": 20,
  "timeWindow": "year",
  "maxResults": 60
}
```

## GitHub Research Intelligence

The system now includes GitHub-native research for implementation answers and reusable code patterns:

- repo discovery (`/search/repositories`)
- issue/forum-style answer discovery (`/search/issues`)
- code-fence snippet extraction from issue bodies
- pipeline integration (`github_research` stage in `/api/v1/masterpiece/pipeline/run`)

Endpoints:

- `GET /api/v1/github/capabilities`
- `POST /api/v1/github/research`

## Live AI Chat

`/api/v1/chat/reply` is model-backed (OpenAI, DeepSeek, Anthropic, Gemini), not rule-based.
It is grounded in benchmark/index intelligence from:
- latest in-app pipeline/scout/benchmark runs
- latest OpenClaw reports when available:
  - `scripts/reports/dashboard-chatbot-repo-scout-latest.json`
  - `scripts/reports/repo-readiness-pulse-latest.json`

Request shape:

```json
{
  "message": "How should we tighten benchmark selection?",
  "provider": "auto",
  "temperature": 0.3,
  "context": {
    "productName": "Inaya Masterpiece Control Plane"
  }
}
```

`provider` options:
- `auto` (default): tries OpenAI, DeepSeek, Anthropic, then Gemini
- `openai`
- `deepseek`
- `anthropic`
- `claude` (alias for `anthropic`)
- `gemini`
- `google` (alias for `gemini`)

If no provider keys are configured, endpoint returns `503 chat_model_not_configured`.

Provider capability endpoint:

- `GET /api/v1/chat/providers`
- Returns configured/not-configured flags and default models per provider
- Returns alias mapping (`claude -> anthropic`, `google -> gemini`)
- Does not expose API keys

Streaming endpoint:

- `POST /api/v1/chat/reply/stream`
- Server-sent events: `start`, `chunk`, `done`, `error`
- Same request body as `/api/v1/chat/reply`
- Supports `sessionId` for persistent chat threads

Session support:

- Include optional `sessionId` in `/api/v1/chat/reply` or `/api/v1/chat/reply/stream`
- If omitted, a new session is created and returned
- Session history is persisted and queryable with `/api/v1/chat/sessions*`

Auto-routing quality:

- In `provider=auto`, provider order is tuned by runtime benchmark-like metrics:
  - moving success rate
  - moving latency
  - moving estimated cost
- Provider metrics are visible via `/api/v1/chat/providers`

## Run

```bash
npm run dev:auto
```

Open: `http://localhost:3000`

## One-Click Deploy (Docker)

```bash
cp .env.example .env
docker compose up -d --build
```

Health:

```bash
curl http://localhost:3000/health
```

## Advanced Indexing Without Extra MCP Setup

No extra MCP tools are required for advanced indexing.
Set:

```bash
EXTERNAL_INDEXING_MODE=builtin
```

Then run the normal pipeline endpoint with `runExternal: true` to execute the built-in advanced indexing stage.

## OpenClaw/MCP-Style Git Indexing API

When you want parity with OpenClaw indexing workflow, use:

- `GET /api/v1/indexing/capabilities`
- `POST /api/v1/indexing/sync`
- `POST /api/v1/indexing/readiness`
- `POST /api/v1/indexing/dashboard-scout`

If OpenClaw scripts are connected at `CLAW_ARCHITECT_ROOT`, these endpoints execute them directly.
If not connected, pipeline still works via built-in advanced indexing mode.

## Security

- Helmet headers
- Rate limiting
- Strict payload validation (Zod)
- Optional Bearer auth
- Secret scan (`npm run security:check`)
- CI checks on push/PR

## Validation Commands

```bash
npm run lint
npm run security:check
npm run test
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Installation](docs/INSTALLATION.md)
- [Roadmap](docs/ROADMAP.md)
- [Gap Analysis](docs/GAP_ANALYSIS.md)
- [Update Notes](docs/UPDATE_NOTES.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [License](LICENSE)
- [LinkedIn Launch Posts](docs/LINKEDIN_LAUNCH_POSTS.md)
- [Claude Code GitHub Agent Prompt](docs/CLAUDE_CODE_GITHUB_AGENT_PROMPT.md)
- [Security Best Practices Report](security_best_practices_report.md)
