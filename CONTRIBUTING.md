# Contributing

## Development Setup

Prereqs:
- Node.js 22
- pnpm

```bash
pnpm install
mkdir -p ~/.thufir
cp config/default.yaml ~/.thufir/config.yaml
pnpm thufir env init
```

## Common Commands

```bash
pnpm dev
pnpm build
pnpm test            # watch
pnpm exec vitest run # CI-style
pnpm lint
pnpm typecheck
```

## Pull Requests

- Keep changes scoped; avoid drive-by refactors.
- Add/adjust tests for behavior changes (`pnpm test`).
- Update docs when you change user-facing CLI/config behavior.
- Do not include secrets, keystores, or `.env` files in commits.

## Reporting Issues

Include:
- what you ran (`pnpm thufir ...`)
- expected vs actual behavior
- relevant config snippets (redacted)
- Node version and OS
