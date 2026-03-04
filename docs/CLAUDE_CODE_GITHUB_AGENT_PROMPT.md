# Claude Code Prompt: Copy Into a New Repo

Copy this into Claude Code inside a new GitHub repo to create your own branded GitHub + Reddit builder agent.

```text
You are my senior engineer. Build a production-ready "GitHub Agent Builder" service in this repository.

Mission:
- Create an API + dashboard that helps users research how to build software using:
  1) GitHub repositories
  2) GitHub issue/forum answers with code snippets
  3) Reddit technical/community answers
- Use this repo as the reference architecture:
  https://github.com/smanthey/InayanBuilderBot

Technical requirements:
1. Runtime + quality
- Node.js 20+
- Express API
- strict payload validation
- security headers + rate limiting
- CI workflow for lint + tests + security checks
- Dockerfile + docker-compose

2. Core endpoints
- POST /api/v1/masterpiece/pipeline/run
- POST /api/v1/scout/run
- POST /api/v1/benchmark/run
- POST /api/v1/chat/reply
- POST /api/v1/chat/reply/stream
- GET /api/v1/chat/providers
- GET /api/v1/github/capabilities
- POST /api/v1/github/research
- GET /api/v1/reddit/capabilities
- POST /api/v1/reddit/search
- GET /health

3. GitHub research engine
- search repos via GitHub API
- search issues (not PRs) for implementation answers
- extract fenced code snippets from issue bodies
- score/rank answers by relevance + engagement + freshness

4. Reddit research engine
- fallback chain: reddit_top -> old_reddit_top -> hot -> new -> rss
- optional auth profile rotation via env
- rank by relevance + engagement + freshness

5. Pipeline integration
- include both github_research and reddit_research stages by default
- keep pipeline resilient: research stages should enrich output, not hard-fail full run
- include top GitHub answer links + top Reddit signals in blueprint output

6. Chat layer
- support OpenAI, DeepSeek, Anthropic, Gemini with provider aliases
- provider auto-routing using success/latency/cost telemetry
- persistent sessions
- SSE streaming replies

7. Repo quality requirements
- README with setup, env, local run, docker run, API examples
- .env.example with placeholders only
- tests that validate pipeline + github research + reddit research + chat behavior
- no secrets committed

8. Final delivery checklist
- run lint
- run tests
- run security checks
- summarize what was built
- provide first-run commands:
  npm install
  npm run setup:auto
  npm run dev:auto

Work style:
- implement directly, do not stop for plan approval
- keep code concise and production-minded
- prioritize reliability and easy local startup
```
