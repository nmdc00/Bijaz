# v1.61 Swarm Control Plane

Purpose: execute v1.61 from scratch with one task per branch/worktree and strict merge gates.

## Branch Base
- release: `release/v1.61`
- baseline sha: `111b07d`

## Global Merge Gates
1. No direct merge to `main`.
2. Feature branches merge only into `release/v1.61`.
3. Required checks per feature merge:
- `pnpm typecheck`
- task-focused vitest suite
4. Required checks before release promotion:
- `pnpm typecheck`
- `pnpm vitest run`

## Tasks
See `workspace/swarm/v1.61/tasks.tsv`.
