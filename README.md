# InayanBuilderBot

**InayanBuilderBot is the Masterpiece Agent + Chat Tool.**

Dedicated to **Suro Jason Inaya**. Built for him personally.

## What It Does

InayanBuilderBot gives you a full benchmark-first workflow in one interface:

1. Scout proven OSS repos for dashboard/chat modules
2. Benchmark and compare candidates
3. Generate a Masterpiece build blueprint
4. Use built-in chat tool for architecture/security/benchmark guidance

## What It Is Based On

- OpenClaw-style benchmark-first build orchestration
- Repo indexing and comparison before implementation
- Secure-by-default API and release hygiene

## Core Endpoints

- `POST /api/v1/scout/run`
- `POST /api/v1/benchmark/run`
- `POST /api/v1/masterpiece/build`
- `POST /api/v1/chat/reply`
- `GET /api/v1/chat/history`
- `GET /api/v1/runs`
- `GET /health`

## Install

```bash
git clone https://github.com/smanthey/InayanBuilderBot.git
cd InayanBuilderBot
npm install
cp .env.example .env
```

Set env values:

- `BUILDERBOT_API_KEY` (strong random value)
- `ALLOWED_ORIGIN` (exact UI origin)
- `GITHUB_TOKEN` (optional, improves GitHub API limits)

## Run

```bash
npm run dev
```

Open `http://localhost:3000`

## Security

- Helmet headers
- API payload validation with Zod
- Rate limiting
- Optional bearer key auth
- `.env` never committed
- `npm run security:check` to prevent secret leakage

## Commands

- `npm run dev`
- `npm run start`
- `npm run lint`
- `npm run security:check`
- `npm run test`

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Installation](docs/INSTALLATION.md)
- [Gap Analysis](docs/GAP_ANALYSIS.md)
- [Security Best Practices Report](security_best_practices_report.md)
