# Thufir Hawat — Claude Code Instructions

## Git Flow (STRICT — never skip levels)

```
feat/<release>-<slug>  →  release/v.x.xx  →  develop  →  main
```

- Feature branches are cut from `release/*` (not `develop`, not `main`)
- Feature PRs target their `release/*` base
- After all features merge into release, open one PR: `release/*` → `develop`
- After develop is green, open one PR: `develop` → `main`
- **Never open a PR directly from any branch to `main` — always promote through `develop` first**

### Hotfix flow

Hotfixes follow the same promotion path — no shortcuts:

```
hotfix/<slug>  →  develop  →  main  →  deploy
```

1. Cut `hotfix/<slug>` from `develop`
2. PR `hotfix/<slug>` → `develop`, run full test suite
3. After develop is green, PR `develop` → `main`
4. Deploy from `main`

### Conflict resolution

- Release wins over develop; develop wins over main
- When conflicts arise, create a `fix/reconcile-<target>-<source>` branch from the target, merge source into it, resolve, then PR into target
- Never force-push `develop` or `main`

## Branch Naming

- Feature branches: `feat/<release>-<task-slug>` (e.g. `feat/v1.91-signal-cache-layer`)
- Release branches: `release/v.x.xx` (e.g. `release/v1.91`)
- Hotfix branches: `hotfix/<slug>` (e.g. `hotfix/leverage-defaults`) — cut from `develop`, promote via `develop` → `main`
- Reconcile branches: `fix/reconcile-<target>-<source>`
- Temp/revert branches: `temp/<description>`

## Sprint Workflow

1. Create `release/v.x.xx` first — treat it as the sprint integration branch
2. Define atomic tasks; each task gets one branch, one PR, one test requirement
3. Implement on feature branch; keep commits task-scoped
4. Validate before PR: run task tests + regression, typecheck, confirm branch is ahead of base
5. Merge feature PRs into release in planned order (foundational first)
6. Promote: release → develop → main after each level is green

### PR Checklist (required before opening)

- Branch is cut from correct base
- `git diff --name-only <base>...<branch>` shows expected files only
- Required tests pass (`pnpm test` and `pnpm typecheck`)
- PR body includes: scope, changed files, tests run, risks

## Commands

These slash commands are available:

- `/commit` — stage all changes and create a single commit
- `/commit-push-pr` — commit, push, and open a PR (branches from main if on main)
- `/clean_gone` — delete local branches whose remotes are gone, including associated worktrees
- `/feature-dev [description]` — guided 7-phase feature development (Discovery → Exploration → Questions → Architecture → Implementation → Review → Summary)

## Test Requirements

- Every feature branch must include tests for its changes
- `pnpm test` must pass before any PR is opened
- `pnpm typecheck` must pass before any PR is opened
- Integration/acceptance tests live in `tests/core/` and `tests/discovery/`
- No merges to release without task-level tests; no merges to develop without full suite green

## Project Stack

- Runtime: Node.js, TypeScript, `pnpm`
- Test framework: Vitest
- Config: YAML (`config/default.yaml`), parsed via Zod in `src/core/config.ts`
- Main entry: `src/index.ts` → `Thufir` class

## Key Architecture (v1.91+)

### LLM Clients (`src/core/llm.ts`)

- `createLlmClient` — primary (Anthropic/OpenAI)
- `createTrivialTaskClient` — local/trivial model (`kind: 'trivial'`)
- `createAgenticExecutorClient(config, toolCtx, model?, toolSubset?)` — agentic with tool loop
- `finalizeMessages(msgs, config, meta?)` — injects identity, sanitizes, trims to budget
- `resolveMaxPromptChars(config, meta?)` — trivial: 10K, enrichment: 10K, autonomous: 60K, chat: 120K

### Tool Subsets (`src/tools/tool-schemas.ts`)

- `discovery` (13 tools), `execution` (12), `chat` (33), `trivial` (4), `full` (50)
- User-facing conversation executor uses `'chat'` subset (not `'execution'`)
- Autonomous enrichment uses trivial client directly (not OrchestratorClient)

### Agent Wiring (`src/core/agent.ts`)

- `ThufirAgent.llm` — primary client
- `ThufirAgent.infoLlm` — trivial client
- `AutonomousManager` receives `infoLlm ?? llm` (direct, never orchestrator)
- `ConversationHandler` receives executor with `toolSubset: 'chat'`

### Config Keys

- `agent.promptBudget.{enrichment, autonomous, trivial, chat}` — char budgets per call kind
- `agent.internalPromptMode` — `'none'` skips 6KB identity prelude for trivial calls
- `discovery.signalCacheTtlSeconds` — TTL for signal function cache (default 300s)

## Code Conventions

- No over-engineering: minimal change for the task, no speculative abstractions
- No backwards-compatibility stubs for removed code — delete cleanly
- Validate only at system boundaries (user input, external APIs)
- Comments only where logic is non-obvious
- Prefer editing existing files over creating new ones
