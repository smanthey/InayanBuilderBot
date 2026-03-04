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

## Run

Development:

```bash
npm run dev
```

Production:

```bash
npm run start
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
