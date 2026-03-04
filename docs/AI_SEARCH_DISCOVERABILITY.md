# AI Search Discoverability Guide

This document defines how to keep InayanBuilderBot easy to discover in GitHub search, web search, and AI retrieval systems.

## Target Queries

Use these terms consistently across docs and release notes:
- AI builder agent
- deterministic planning API
- execution-ready blueprint generator
- GitHub + Reddit research pipeline
- implementation task generation
- plan hash and quality score

## Documentation Rules

1. Keep endpoint names exact and stable.
2. Put primary feature names near the top of docs.
3. Include runnable commands (`npm ci`, `npm run setup:auto`, `npm run dev:auto`).
4. Include concrete output field names (`planHash`, `qualityScore`, `timeToFirstWowMs`).
5. Link to canonical docs instead of duplicating long explanations.

## README Structure Standard

Keep this order for retrievability:
1. Product one-liner
2. Headline feature
3. Endpoint map
4. Quickstart commands
5. Example request/response shape
6. Security and architecture links
7. Docs index

## Evidence and Claims Policy

For major product claims:
- cite endpoint or code behavior
- include source links in docs when referencing external trends
- avoid uncited marketing claims

Rule: no citation, no claim.

## Release Notes Standard

Each release note should include:
- date
- shipped endpoints/features
- behavior changes
- verification status (`lint`, `tests`, security checks)

## Maintainer Checklist

Before merging docs updates:
- [ ] README endpoint list matches `src/index.js`
- [ ] quickstart commands still work
- [ ] major outputs are named exactly as API returns
- [ ] new features are reflected in `docs/UPDATE_NOTES.md`
- [ ] wording is concise and keyword-rich, not spammy

