# Gap Analysis

Date: 2026-03-04

## Coordination with OpenClaw Mission Control (claw-architect)

This gap analysis is kept in sync with:

- **Indexing:** jCodeMunch `index_folder` on InayanBuilderBot and claw-architect (see `docs/MCP-INDEX-TARGETS.md` in claw-architect).
- **Builder pulse:** `npm run builder:gap:pulse -- --repos InayanBuilderBot` (runs repo-completion-gap-one.js, queues autofix when needed).
- **Benchmark lookup:** `npm run repo:benchmark:lookup -- --repo InayanBuilderBot` → `reports/repo-completion-benchmark-lookup-latest.md` with GitHub search links per section.
- **Research:** Reddit search (`reddit:search`) and GitHub research feed `data/builtin-repo-index.json` and masterpiece/magic-run evidence.

Run these from claw-architect to refresh gaps and benchmark refs; then update this doc and `docs/RESEARCH_AND_BENCHMARKS.md` as needed.

## Latest run (2026-03-04): section status and next actions

- **Next actions (P1):** Add tenant resolver and organization_id guardrails (capability_factory_health).
- **Sections:** email_setup, admin_setup, auth, telnyx_sms, webhooks_signature_verify, queue_retry, observability, e2e, security_sweep = incomplete; stripe_checkout, stripe_webhooks, capability_factory_health = gap.
- **Benchmark lookup:** See claw-architect `reports/repo-completion-benchmark-lookup-latest.md` for GitHub search links and best-case refs (e.g. local/autopay_ui, local/CaptureInbound, local/payclaw for Stripe; config/capabilities.yaml for capability factory).

## External completion validation (2026-03-04)

- `veritap` is fully complete in capability scan (no incomplete sections, no issues).
- `veritap_2026` reached full section completion after queue/observability/e2e/security hardening and forbidden-pattern cleanup.
- For privacy-safe runs, use no-link mode so gap reports include queries/evidence without external URLs:
  - `npm run repo:completion:gap -- --repo veritap_2026 --no-research-links`

## Current Strength

InayanBuilderBot already ships a strong baseline for deterministic AI planning:
- magic-run orchestration
- GitHub + Reddit research stages
- quality scoring and self-repair
- execution bridge generation
- tests, CI, and security checks

## Highest-Leverage Gaps

1. Research precision
- Improve filtering confidence to reduce noisy repo candidates.

2. Service modularity
- Split `src/index.js` into focused modules for lower regression risk.

3. Persistence scalability
- Add Postgres-first mode for collaborative/enterprise usage.

4. Reproducibility artifacts
- Persist benchmark manifests with exact inputs and scoring context.

5. API contract discoverability
- Publish OpenAPI for faster integration and AI retrieval.

## 30-Day Technical Plan

Week 1:
- implement stricter candidate confidence filters
- add benchmark manifest persistence

Week 2:
- modularize research/scoring/route layers
- add OpenAPI generation and validation

Week 3:
- introduce Postgres-backed persistence mode
- add provider circuit-breaker state reporting

Week 4:
- ship weekly benchmark artifact publishing
- expand contributor templates for benchmark and provider adapters

## Success Metrics

- lower off-target benchmark candidates
- faster contributor onboarding
- higher reproducibility of repeated magic-run outputs
- better external API adoption
