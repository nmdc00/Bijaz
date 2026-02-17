# Thufir Development Progress

**Last Updated:** 2026-02-17

## Current Status
`develop` now includes closed v1.6 scope plus v1.6.1 stabilization.
Baseline commit: `d71dee0` (`origin/develop`).

Validation on current baseline:
1. `pnpm run build` passed
2. `pnpm vitest run` passed (`107` files / `335` tests)

## Completed
v1.6 and v1.6.1 closure highlights:

1. Mechanical expression selection (LLM removed from execution hot-path selection).
2. Market metadata/mids caching + scan snapshot reuse.
3. Event-driven scan triggers.
4. Deterministic execution input validation and retry classification hardening.
5. IOC quote freshness enforcement.
6. Async non-blocking LLM enrichment.
7. Performance telemetry + performance acceptance evaluator.
8. Non-critical LLM fallback suppression by reason + cooldown windows.
9. Active-chat LLM suppression for heartbeat/proactive scheduler paths.
10. v1.6.1 stabilization fixes:
- duplicate reduce-only exit assessment declaration removed,
- async enrichment context wiring fixed,
- gateway nullability hardening,
- orchestrator exit-mode alias normalization,
- reduce-only/FSM contract-validation order fixes.

## In Progress
1. `feat/v1.6.1-scheduled-report-jobs` (pivoted to generic tasks):
- explicit scheduled task commands (`/schedule`, `/scheduled_tasks`, `/unschedule_task`),
- persisted scheduler-backed task jobs with startup rehydration,
- scheduled entries execute arbitrary instructions through normal agent flow,
- natural-language time-intent guard to prevent accidental trade execution.
2. Deployment/runtime soak on server for latest `develop` baseline.

## Next Steps
1. Deploy/restart from `develop` (`6c0a949`) and validate live gateway flows.
2. Confirm proactive + heartbeat behavior under active-chat suppression in production logs.
3. Continue remaining v1.5 operational/autonomy polish items.
