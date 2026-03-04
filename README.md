# InayanBuilderBot

**InayanBuilderBot is the complete Masterpiece Agent + Chat Tool.**

Dedicated to **Suro Jason Inaya**. Built for him personally.

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
- `POST /api/v1/chat/reply`
- `GET /api/v1/chat/providers`
- `GET /api/v1/chat/history`
- `GET /api/v1/runs`
- `GET /health`

## Robust Pipeline: What It Executes

`/api/v1/masterpiece/pipeline/run` performs:

1. Scout candidate repos from GitHub (or seed repos)
2. Exclude low-signal framework-only repos
3. Benchmark and compare top candidates
4. Optionally execute external OpenClaw indexing/scout stack:
   - `index:sync:agent`
   - `repo:readiness:pulse`
   - `dashboard:repo:scout`
5. Produce a final build blueprint based on selected top repos
6. Persist artifacts to `.data/runs.json`

## Install

```bash
git clone https://github.com/smanthey/InayanBuilderBot.git
cd InayanBuilderBot
npm install
cp .env.example .env
```

## Configure

Set in `.env`:

- `BUILDERBOT_API_KEY` (recommended for production)
- `ALLOWED_ORIGIN`
- `GITHUB_TOKEN` (recommended for GitHub API limit)
- `CLAW_ARCHITECT_ROOT` (optional, default `/Users/tatsheen/claw-architect`)
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

## Run

```bash
npm run dev
```

Open: `http://localhost:3000`

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
- [Gap Analysis](docs/GAP_ANALYSIS.md)
- [Update Notes](docs/UPDATE_NOTES.md)
- [Security Best Practices Report](security_best_practices_report.md)
