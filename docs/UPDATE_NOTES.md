# Update Notes

## 2026-03-04 (OpenClaw indexing + builder pulse + research + benchmark sync)

### Summary

Aligned InayanBuilderBot with OpenClaw Mission Control (claw-architect) improvement loop: symbol indexing, builder gap pulse, Reddit/GitHub research, and repo-completion benchmark lookup.

### What was run (from claw-architect)

- **Indexing:** jCodeMunch `index_folder` on claw-architect and InayanBuilderBot for fast symbol search and outlines.
- **Builder gap pulse:** `npm run builder:gap:pulse -- --repos InayanBuilderBot` (dry-run); gap analysis via `repo-completion-gap-one.js`.
- **Benchmark lookup:** `npm run repo:benchmark:lookup -- --repo InayanBuilderBot` → GitHub search links and best-case refs per capability section.
- **Reddit research:** `npm run reddit:search` with query "open source AI builder agent MCP deterministic" (200 posts indexed).

### Doc updates

- **GAP_ANALYSIS.md:** Added "Coordination with OpenClaw Mission Control" and "Latest run" section with section status, next actions (tenant resolver, organization_id guardrails), and pointer to benchmark lookup report.
- Keeps single source of truth: run builder/benchmark from claw-architect; update this repo's docs when improving from that intel.

### Coordination note

Another agent may commit to the same repos. Use `git pull --rebase` before pushing; keep commits focused and notes detailed so merges stay clean.

---

## 2026-03-04 (Repo-Wide Positioning and Discoverability Refresh)

### Summary

Updated repository-wide written content to maximize product positioning, SEO clarity, and AI-search retrievability.

### What changed

- standardized product language around:
  - deterministic Magic Run
  - proof metrics (`timeToFirstWowMs`, `planHash`, `qualityScore`)
  - execution-ready blueprint and execution bridge
  - simple to install, cheap to run, amazing to use, built to work
- refreshed core docs for consistent technical positioning:
  - architecture, installation, onboarding, roadmap, security
  - benchmarks/research guidance
  - MCP verification documentation
  - contribution and launch content
- updated issue templates for clearer bug and feature signal quality
- updated npm metadata for discoverability (description/keywords/repo links)

### Verification

- docs cross-check against current API surface in `src/index.js`
- lint/tests/security checks run after changes

---

## 2026-03-04 (README Professional Refresh + AI Search Discoverability)

### Summary

Refactored documentation for clearer product positioning, faster onboarding, and stronger SEO/AI retrieval performance.

### Changes shipped

- Rewrote `README.md` with:
  - deterministic magic-run headline positioning
  - complete endpoint grouping by function
  - quickstart + health verification commands
  - runnable magic-run `curl` example
  - quality/determinism proof metrics (`planHash`, `qualityScore`, `timeToFirstWowMs`)
  - architecture, security, and docs cross-links
- Added new maintainer guide:
  - `docs/AI_SEARCH_DISCOVERABILITY.md`
  - standards for keyword consistency, endpoint naming, evidence claims, and release-note hygiene

### Verification

- README endpoint list cross-checked against `src/index.js` routes.
- Documentation index updated to include discoverability guide.

---

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

### Research refresh and benchmark implementation

- Re-ran GitHub + Reddit research signal pass.
- Refreshed benchmark metadata in `data/builtin-repo-index.json`.
