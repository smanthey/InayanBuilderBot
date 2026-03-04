# InayanBuilderBot

Production-ready **AI Builder Agent API** that turns idea inputs into **deterministic, execution-ready build plans**.

Simple to install. Cheap to run. Amazing to use. Built to work.

It combines GitHub + Reddit research signals, benchmark scoring, and strict quality gates to produce:
- executable blueprint artifacts
- implementation task breakdowns
- rollout/rollback and test plans
- deterministic proof data (`planHash`, `qualityScore`, `timeToFirstWowMs`)

[![CI](https://github.com/smanthey/InayanBuilderBot/actions/workflows/ci.yml/badge.svg)](https://github.com/smanthey/InayanBuilderBot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

## Why This Exists

Most AI planning tools stop at prompt text. InayanBuilderBot focuses on a narrower, high-value outcome:

**Deterministic Magic Run**: one API call that executes
`Scout -> Benchmark -> Blueprint -> Execution Task List`

with reproducible output structure, evidence citations, and pre-ship quality checks.

## Product Positioning

- **Simple to install**: `npm ci && npm run setup:auto && npm run dev:auto`
- **Cheap to run**: Node + Express, low infrastructure requirements, optional local-first mode
- **Amazing to use**: one-click Magic Run and recompile diff flow
- **Built to work**: strict schemas, proof metrics, tests, CI, and security checks

## Headline Feature: Deterministic Magic Run

Endpoint: `POST /api/v1/masterpiece/magic-run`

What it guarantees:
- deterministic sorting + hashing (`planHash`) for reproducibility
- hard schema validation for blueprint and execution tasks
- quality scoring with auto-repair attempts before final output
- project memory updates for better future recompiles
- research-evidence attachment for major decisions

Primary output fields:
- `timeToFirstWowMs`
- `planHash`
- `qualityScore`
- `blueprint`
- `executionBridge`
- `evaluation`
- `markdownPlan`

Execution output now includes Playwright-focused E2E planning artifacts by default:
- `tests/e2e/magic-run.spec.ts`
- `tests/e2e/deploy-targets.spec.ts`
- `playwright.config.ts`

Related endpoints:
- `POST /api/v1/masterpiece/recompile`
- `GET /api/v1/masterpiece/magic-run/demo`
- `GET /api/v1/projects/:projectKey/memory`
- `GET /api/v1/product/focus`

Real-system execution mode (`/api/v1/masterpiece/pipeline/run` with `runExternal=true` + `EXTERNAL_INDEXING_MODE=openclaw`) now includes a repo completion stage:
- `external_release_four_repos_check`
- emits `release_summary.hard_failures` and `release_summary.env_blocked_checks`
- emits `dependency_hint` when a repo fails from missing local install dependencies (e.g. missing `vite`)

## API Surface

### Masterpiece + Pipeline
- `POST /api/v1/masterpiece/magic-run`
- `POST /api/v1/masterpiece/recompile`
- `GET /api/v1/masterpiece/magic-run/demo`
- `POST /api/v1/masterpiece/pipeline/run`
- `POST /api/v1/masterpiece/build`
- `GET /api/v1/product/focus`
- `GET /api/v1/projects/:projectKey/memory`

### Research + Benchmark
- `POST /api/v1/scout/run`
- `POST /api/v1/benchmark/run`
- `GET /api/v1/github/capabilities`
- `POST /api/v1/github/research`
- `GET /api/v1/reddit/capabilities`
- `POST /api/v1/reddit/search`
- `POST /api/v1/research/fusion`

### Chat + Sessions
- `POST /api/v1/chat/reply`
- `POST /api/v1/chat/reply/stream` (SSE)
- `GET /api/v1/chat/providers`
- `GET /api/v1/chat/history`
- `GET /api/v1/chat/sessions`
- `GET /api/v1/chat/sessions/:sessionId`

### Indexing + Setup + Health
- `GET /api/v1/indexing/capabilities`
- `POST /api/v1/indexing/sync`
- `POST /api/v1/indexing/readiness`
- `POST /api/v1/indexing/dashboard-scout`
- `POST /api/v1/index/refresh`
- `GET /api/v1/index/search?q=...`
- `GET /api/v1/index/stats`
- `GET /api/v1/setup/status`
- `POST /api/v1/setup/onboard`
- `GET /api/v1/runs`
- `GET /health`

## First Run (Under 2 Minutes)

```bash
git clone https://github.com/smanthey/InayanBuilderBot.git
cd InayanBuilderBot
npm ci
npm run setup:auto
npm run dev:auto
```

Health and checks:

```bash
npm run lint
npm run security:check
npm run mcp:health
npm test
npm run test:e2e
```

macOS shortcut: double-click `launch.command`.

## Example: Magic Run

```bash
curl -X POST http://localhost:3030/api/v1/masterpiece/magic-run \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-dev-key' \
  -d '{
    "productName": "InayanBuilder",
    "userGoal": "Generate deterministic, implementation-ready AI product plans",
    "stack": ["node", "typescript", "postgres", "react"],
    "constraints": {
      "budgetUsd": 5000,
      "deadlineDays": 14,
      "teamSize": 2
    },
    "timeoutTier": "fast",
    "deterministic": true,
    "idempotencyKey": "demo-run-001"
  }'
```

Expected response highlights:
- `productFocus: "deterministic_magic_run"`
- `planHash: "..."`
- `qualityScore: <number>`
- `timeToFirstWowMs: <number>`
- `executionBridge.tasks[]` with owner, estimate, dependencies, acceptance criteria

## Example: Real Repo Completion Run

Use this to validate and improve actual repos (not just plan generation):

```bash
curl -X POST http://localhost:3030/api/v1/masterpiece/pipeline/run \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-dev-key' \
  -d '{
    "productName": "Repo Completion Sweep",
    "userGoal": "Find hard failures across active repos and classify env-blocked checks",
    "stack": ["node", "express", "postgres"],
    "queries": ["repo reliability checks", "dashboard chat ai builder"],
    "runExternal": true,
    "runGithubResearch": false,
    "runRedditResearch": false
  }'
```

Look for:
- `stageResults[].stage == "external_release_four_repos_check"`
- `stageResults[].detail.release_summary`
- `stageResults[].detail.dependency_hint`

## Determinism + Quality Gates

Output quality is enforced by design:
- strict Zod schemas for blueprint and execution tasks
- required implementation sections (API contracts, migrations, tests, rollout/rollback)
- auto-repair for failing quality criteria
- request caps for budget and timeout tiering (`fast`, `standard`, `deep`)
- idempotency key replay support
- pipeline-stage caching for GitHub/Reddit research to speed repeat runs

## Project Memory (Continuity)

Per-project memory is persisted and reused in recompiles:
- accepted decisions
- rejected options + reasons
- hard constraints
- decision history and latest `planHash`

This reduces rework and keeps iteration stateful.

## Research Signals (GitHub + Reddit)

Research is native to the product:
- GitHub repo + issues/code-answer evidence
- Reddit fallback-chain signal collection and ranking
- fusion leaderboard that blends benchmark + research evidence
- citation attachment for major planning decisions

See: [`docs/RESEARCH_AND_BENCHMARKS.md`](./docs/RESEARCH_AND_BENCHMARKS.md)

## Gap Intelligence Updates (OpenClaw Integration)

InayanBuilderBot now pairs with the claw-architect completion loop for repo-level execution readiness:

- confidence-scored section status (`complete`, `incomplete`, `partial`, `gap`)
- evidence-backed findings (file + matched signal snippets)
- prioritized `research_backlog` generation for remaining gaps
- issue-level evidence bundles for faster autofix planning
- optional link-suppressed mode for private/internal runs

Example (from claw-architect):

```bash
npm run repo:completion:gap -- --repo veritap_2026 --no-research-links
```

Use this mode when you want clear completion status and exact missing sections without emitting GitHub/Reddit URLs in output artifacts.

## Environment Variables

Core:
- `BUILDERBOT_API_KEY`
- `ALLOWED_ORIGIN`
- `EXTERNAL_INDEXING_MODE` (`builtin` | `auto` | `openclaw`)
- `MAGIC_RUN_MAX_BUDGET_USD` (optional cap)
- `SQLITE_INDEX_ENABLED` (`1` by default)
- `INAYAN_DB_PATH` (default: `.data/inayan-index.db`)
- `INAYAN_E2E_MOCK_MODE` (`1` only for deterministic local/CI Playwright runs)

GitHub:
- `GITHUB_TOKEN`
- `GITHUB_PERSONAL_ACCESS_TOKEN` (optional alias)

Chat providers:
- `OPENAI_API_KEY`
- `DEEPSEEK_API_KEY`
- `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY`
- `GEMINI_API_KEY` or `GOOGLE_API_KEY`

Reddit intelligence:
- `REDDIT_USER_AGENT`
- `REDDIT_DEFAULT_SUBREDDITS`
- `REDDIT_REQUEST_TIMEOUT_MS`
- `REDDIT_AUTH_PROFILES` (optional)

Setup and MCP details:
- [`docs/ONBOARDING.md`](./docs/ONBOARDING.md)
- [`docs/MCP-SERVERS.md`](./docs/MCP-SERVERS.md)

## Architecture + Security

- Express API + middleware hardening (`helmet`, rate-limits, API key auth)
- data persistence in `.data/` for runs, memory, and chat sessions
- SQLite index store for repos, evidence, snapshots, query cache, and project memory (`.data/inayan-index.db`)
- secret handling + security checks in CI
- Docker support via `Dockerfile` and `docker-compose.yml`

See:
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- [`docs/SECURITY.md`](./docs/SECURITY.md)

## Documentation Index

- [`docs/UPDATE_NOTES.md`](./docs/UPDATE_NOTES.md)
- [`docs/RESEARCH_AND_BENCHMARKS.md`](./docs/RESEARCH_AND_BENCHMARKS.md)
- [`docs/GAP_ANALYSIS.md`](./docs/GAP_ANALYSIS.md)
- [`docs/ONBOARDING.md`](./docs/ONBOARDING.md)
- [`docs/AI_SEARCH_DISCOVERABILITY.md`](./docs/AI_SEARCH_DISCOVERABILITY.md)

## SEO + AI Discoverability Notes

This README is intentionally written for both human readers and AI retrieval systems:
- stable product naming (`InayanBuilderBot`, `Deterministic Magic Run`)
- endpoint-first sections for machine parsing
- explicit keyword coverage (`AI builder agent`, `deterministic planning`, `GitHub research`, `Reddit research`, `execution bridge`)
- concise run commands and reproducible outputs

For maintainers, see: [`docs/AI_SEARCH_DISCOVERABILITY.md`](./docs/AI_SEARCH_DISCOVERABILITY.md)

## License

MIT - see [`LICENSE`](./LICENSE)
