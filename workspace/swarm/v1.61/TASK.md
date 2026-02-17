# feat/v1.61-operator-progress-streaming

Agent: agent-v161-m
Task: Operator progress streaming

## Scope
Progress milestones with dedupe/cooldown

## Acceptance
- Implementation is isolated to this branch only.
- Behavior is deterministic and documented in tests.
- No regressions outside task scope.

## Required Tests
- pnpm typecheck
- pnpm vitest run tests/gateway/escalation.test.ts tests/core/conversation-tool-snapshot.test.ts

## Merge Target
- release/v1.61
