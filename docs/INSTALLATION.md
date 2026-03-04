# Installation and Operations

## Prerequisites

- Node.js 20+
- npm 10+

## Install

```bash
git clone https://github.com/smanthey/InayanBuilderBot.git
cd InayanBuilderBot
npm install
cp .env.example .env
```

Set values in `.env`:

- `PORT`
- `BUILDERBOT_API_KEY`
- `ALLOWED_ORIGIN`
- `EXTERNAL_INDEXING_MODE` (`auto`, `builtin`, `openclaw`)
- at least one model provider key:
  - `OPENAI_API_KEY`
  - `DEEPSEEK_API_KEY`
  - `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY`
  - `GEMINI_API_KEY` or `GOOGLE_API_KEY`

## Run

Development:

```bash
npm run dev
```

Production:

```bash
npm run start
```

Docker one-click:

```bash
docker compose up -d --build
```

For self-contained advanced indexing integration (no external toolchain), set:

```bash
EXTERNAL_INDEXING_MODE=builtin
```

## Health Check

```bash
curl http://localhost:3000/health
```

## Security Gate Before Push

```bash
npm run lint
npm run security:check
npm run test
```

## Deploy Notes

- Put service behind reverse proxy/TLS in production.
- Keep `BUILDERBOT_API_KEY` in secret manager or host env, never in git.
- Set restrictive `ALLOWED_ORIGIN`.
