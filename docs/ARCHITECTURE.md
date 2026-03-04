# Architecture

## Purpose

Inayan Builder Bot provides a secure API and dashboard to create implementation plans for dashboard/chat UI products.

## Components

1. `src/index.js`
- Express API server
- Security middleware
- Request validation and endpoint handling

2. `public/index.html`
- Browser dashboard for submitting build requests
- Displays generated plan response

3. `scripts/security-check.mjs`
- Scans repository content for likely sensitive secrets

## Data Flow

1. User submits project requirements via dashboard or API.
2. API validates payload with Zod.
3. Service returns a phased build plan with benchmark-first sequence.
4. Optional API key enforces authenticated access.

## Design Principles

- Security first
- Minimal operational complexity
- Ready for benchmark/index stage expansion
- Human-readable outputs for handoff and planning
