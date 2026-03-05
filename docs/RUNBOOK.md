# InayanBuilderBot — Runbook

Operational runbook for running, integrating, and improving InayanBuilderBot.

## Mission Control / claw-architect integration

InayanBuilderBot is the **builder product** in the Index + Inayan Builder Loop. It is used by:

- **claw-architect** (Mission Control): builder-gap-pulse, research agenda, and manual/API calls.
- **Index → Research → Benchmark → Update** loop: each time you index a repo, use InayanBuilderBot to research Reddit and GitHub, find similar repos, benchmark, and update the app.

### Contract for Mission Control

- **Reddit search:** `POST /api/v1/reddit/search` — query-driven Reddit research (subreddits, ranking).
- **GitHub research:** `POST /api/v1/github/research` — repo discovery, releases, signals.
- **Research fusion:** `POST /api/v1/research/fusion` — combine Reddit + GitHub into a single research output (magic-run input).
- **Magic run:** `POST /api/v1/masterpiece/magic-run` — Scout → Benchmark → Blueprint → Execution Task List.
- **Health:** `GET /health` — liveness for dashboards.

### Environment

- Copy `.env.example` to `.env` and set:
  - `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` (optional, for Reddit OAuth).
  - `GITHUB_TOKEN` (optional, for GitHub API).
  - `x-api-key` header for API calls (e.g. `local-dev-key` for local).
- See `.env.example` and [INSTALLATION.md](./INSTALLATION.md).

### How claw-architect calls InayanBuilderBot

- **Reddit research:** `npm run reddit:search` in claw-architect uses its own script; for InayanBuilderBot-backed research, POST to `http://<host>:3030/api/v1/reddit/search` (or use builder-research-agenda outputs as input).
- **Builder gap pulse:** Does not automatically call InayanBuilderBot; it queues repo_autofix and opencode_controller for repos with gaps. InayanBuilderBot is a priority repo and is benchmarked via `repo:completion:gap --repo InayanBuilderBot`.

## Pipeline: Video → index → brief → research → benchmark → InayanBuilderBot

Repeatable pipeline used to drive InayanBuilderBot from tutorial videos and research:

1. **Video URLs** → Add to `claw-architect/data/youtube-urls.txt`.
2. **YouTube index** → `npm run youtube:index:auto` (in claw-architect); produces `reports/youtube-transcript-visual-index-latest.json`.
3. **Brief** → `npm run youtube:index:to-brief` (in claw-architect); produces `docs/INAYAN-BUILDER-VIDEO-SPEC.md`.
4. **Research** → `npm run reddit:search` and `npm run builder:research:agenda -- --rolling` (in claw-architect).
5. **Benchmark** → `npm run repo:completion:gap -- --repo InayanBuilderBot` (in claw-architect).
6. **Update** → Apply improvements to InayanBuilderBot (this repo); run full cycle until no gaps: `npm run inayan:full-cycle -- --until-repo InayanBuilderBot` (in claw-architect).

## First run (this repo)

```bash
npm ci
npm run setup:auto
npm run setup:index:shared
npm run dev:auto
```

## Quality gates

- `npm run lint`
- `npm run security:check`
- `npm test`
- `npm run test:e2e`

## Troubleshooting

- **Reddit/GitHub 4xx:** Check env (REDDIT_*, GITHUB_TOKEN); use optional OAuth or tokens.
- **Health failing:** Ensure SQLite/DB and required env are set; see INSTALLATION.md.
- **Mission Control not reaching InayanBuilderBot:** Ensure InayanBuilderBot is running (e.g. port 3030) and CORS/network allow requests from Mission Control host.
