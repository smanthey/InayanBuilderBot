# LinkedIn Launch Posts

Use these as ready-to-post launch options for InayanBuilderBot.

GitHub link: https://github.com/smanthey/InayanBuilderBot

## Post 1 (Founder Build Log Style)

I just shipped InayanBuilderBot, a production-ready builder agent that combines:
- GitHub repo research
- GitHub issue/forum answer mining with code snippet extraction
- Reddit research with fallback sourcing and ranking
- Multi-provider AI chat routing (OpenAI, DeepSeek, Anthropic, Gemini)

This is not a concept demo. It runs as a real service with API endpoints, tests, CI, Docker, and security checks.

If you want to build your own agent stack faster, clone it and fork the workflows:
https://github.com/smanthey/InayanBuilderBot

If you are building in public, drop your repo below and I will share one practical improvement I would make first.

## Post 2 (Direct Technical Style)

Most builder agents stop at "find repos by stars."

InayanBuilderBot goes further:
- ranks dashboard/chat OSS repos
- pulls implementation answers from GitHub issues
- extracts code snippets from answer threads
- adds Reddit signal research for real-world build patterns
- feeds all of that into the build pipeline and model-backed chat

Repo:
https://github.com/smanthey/InayanBuilderBot

If you are a Claude Code user, you can use this as your base and spin up your own GitHub agent in one repo.

## Post 3 (Operator + Dev Audience)

Built and open-sourced: InayanBuilderBot

What I cared about:
- runs from a clean GitHub clone
- clear install + env path
- CI that catches breakage
- security checks before push
- practical research stack (GitHub + Reddit) instead of vibes-only planning

GitHub:
https://github.com/smanthey/InayanBuilderBot

Happy to share the exact Claude Code bootstrap prompt if you want to fork this into your own branded agent.
