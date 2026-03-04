# Contributing to InayanBuilderBot

Thanks for contributing.

## Fast Start

```bash
npm ci
npm run setup:auto
npm run lint
npm run test
npm run security:check
```

## Development Workflow

1. Create a branch from `main`.
2. Make focused changes (one concern per PR when possible).
3. Add or update tests for behavior changes.
4. Run validation locally:

```bash
npm run lint
npm run test
npm run security:check
```

5. Open a PR using the template.

## What We Prioritize

- Reliability over cleverness
- Clear API contracts
- Strong security defaults
- Good docs and copy-paste examples

## PR Quality Bar

- No secrets committed
- No broken tests
- Inputs validated
- Failure paths handled and tested

## Commit Style

Use clear prefixes where possible:
- `feat:` new behavior
- `fix:` bug fix
- `docs:` documentation only
- `chore:` maintenance
- `test:` test changes

## Security Reports

If you find a security issue, do not open a public exploit issue first.
Open an issue with minimal reproduction and label it `security`.
