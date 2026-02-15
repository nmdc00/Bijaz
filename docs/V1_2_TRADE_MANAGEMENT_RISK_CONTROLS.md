# v1.2: Trade Management (Exchange-Native Risk Controls)

## Summary
Trade Management is the “mechanical exits” layer: after entering a position it immediately installs exchange-native risk controls (server-side TP/SL), continuously reconciles that those controls exist, and can flatten positions under hard exit conditions (liquidation guard, max loss/stop, time stop).

On `main`, this is implemented under `src/trade-management/*` and is started inside the agent lifecycle (`src/core/agent.ts`).

This document focuses on the minimal subset that is essential for a trading AI system:
- Place/maintain server-side bracket orders (SL/TP, optional trailing)
- Reconcile fills and ensure bracket exists; re-place if missing
- Close loop that can flatten positions on hard triggers

## Why This Matters
Tool calling and “can place orders” is not sufficient. A production trading system must be able to remain safe when:
- The LLM is rate-limited / flaky.
- The process OOMs or restarts.
- Network calls intermittently fail.
- The agent loses context mid-trade.

Exchange-native stops + an independent close loop provide survivability.

## Goals (v1.2)
- Install bracket orders immediately after entry (best-effort, retryable).
- Keep a minimal persistent state per trade/position (so restarts don’t lose risk controls).
- Periodically:
  - Verify brackets exist.
  - Evaluate exit conditions and flatten if needed.
- Prefer deterministic logic over LLM for exit conditions.

## Implementation On `main` (What Exists Today)

### Key Components
- `TradeManagementService` (`src/trade-management/service.ts`)
  - Starts a `TradeMonitor` if `tradeManagement.enabled: true`.
- `TradeMonitor` (`src/trade-management/monitor.ts`)
  - Periodic tick loop.
  - In live mode, reads Hyperliquid positions + mids; in paper mode uses market client mids.
  - Maintains runtime state (watermarks, trailing-arm state, close-pending throttling).
  - Evaluates exits and executes close orders when required.
- `placeExchangeSideTpsl` (`src/trade-management/hyperliquid-stops.ts`)
  - Places Hyperliquid trigger orders for SL and TP using `grouping: 'positionTpsl'`.
  - Converts computed prices/sizes to venue formats using tick/size decimals.
- `reconcileEntryFill` (`src/trade-management/reconcile.ts`)
  - Given an entry `cloid`, looks up fills since a time window and computes:
    - average fill price
    - fees
    - closed pnl (if any)
- `buildTradeEnvelopeFromExpression` (`src/trade-management/envelope.ts`)
  - Constructs a durable “envelope” for the trade (risk parameters, thesis, expiry, etc.).
  - Clamps requested risk settings to configured bounds.

### Exit Conditions (TradeMonitor.evaluateExit)
Implemented as deterministic checks:
- Liquidation guard:
  - If liquidation distance (bps) <= `tradeManagement.liquidationGuardDistanceBps` => exit `liquidation_guard`
- Stop loss:
  - If `pnlPct <= -stopLossPct` => exit `stop_loss`
- Trailing stop (if enabled and armed):
  - For long: if mid <= highWater * (1 - trail) => `trailing_stop`
  - For short: if mid >= lowWater * (1 + trail) => `trailing_stop`
- Take profit:
  - If `pnlPct >= takeProfitPct` => `take_profit`
- Time stop:
  - If `now > expiresAt` => `time_stop`

### Close Execution
When exiting, `TradeMonitor`:
- Cancels existing SL/TP oids best-effort (for non SL/TP exits) to avoid stale triggers firing after manual close.
- Sends a reduce-only market close via the configured `ExecutionAdapter` (Hyperliquid live or paper).
- Retries close once with expanded slippage if still open.
- Handles “dust” (tiny remaining notional) by closing the envelope and avoiding infinite retries.

### Configuration Surface (On `main`)
Defined in `config/default.yaml` and validated in `src/core/config.ts`:
```yaml
tradeManagement:
  enabled: true
  defaults:
    stopLossPct: 3.0
    takeProfitPct: 5.0
    maxHoldHours: 72
    trailingStopPct: 2.0
    trailingActivationPct: 1.0
  bounds:
    stopLossPct: { min: 1.0, max: 8.0 }
    takeProfitPct: { min: 2.0, max: 15.0 }
    maxHoldHours: { min: 1, max: 168 }
    trailingStopPct: { min: 0.5, max: 5.0 }
    trailingActivationPct: { min: 0.0, max: 5.0 }
  monitorIntervalSeconds: 900
  activeMonitorIntervalSeconds: 60
  useExchangeStops: true
  liquidationGuardDistanceBps: 800
  closeExecution:
    closeTimeoutSeconds: 5
    closeSlippageMultiplier: 2.0
  closeRetryMinSeconds: 30
  dustMaxRemainingNotionalUsd: 0.5
  antiOvertrading:
    maxConcurrentPositions: 2
    cooldownAfterCloseSeconds: 3600
    maxDailyEntries: 4
    lossStreakPause:
      consecutiveLosses: 3
      pauseSeconds: 21600
```

## How This Fits Into v1.1 (Backport Plan)
v1.1 can ship a minimal, production-grade version of trade management by implementing just three invariants:

### Invariant A: Brackets After Entry
After a successful entry fill:
- Compute SL/TP trigger prices from the executed average entry price.
- Place Hyperliquid exchange-native triggers (`tpsl: 'sl'` and `tpsl: 'tp'`) as a grouped bracket.
- Persist the intended bracket prices and returned oids durably (SQLite).

On `main`, this logic is `placeExchangeSideTpsl(...)` + envelope persistence.

### Invariant B: Reconciliation
Because entry orders can fill partially or after a delay:
- Entries must include a unique `clientOrderId` / `cloid`.
- After entry, call `reconcileEntryFill(...)` to compute `avgPx` and fees.
- If reconciliation fails (no fills yet), retry on a backoff until a deadline.

### Invariant C: Close Loop
Independently of LLM and chat:
- Run a periodic `TradeMonitor` tick that:
  - loads open positions and mids
  - evaluates deterministic exit conditions
  - flattens via reduce-only market closes if triggered
  - cancels stale triggers when flattening outside SL/TP paths

### Suggested v1.1 Scope (Minimal DB Schema)
If v1.1 does not have the full envelope + journaling stack, persist a minimal record per open position:
- `symbol`, `side`, `size`, `entryPrice`, `enteredAt`, `expiresAt`
- `stopLossPct`, `takeProfitPct`, optional trailing settings
- `slOid`, `tpOid`
- `highWater`, `lowWater`, `trailingActivated`

This is sufficient for:
- checking that brackets exist
- re-placing missing brackets
- trailing logic
- time stop enforcement

## Testing & Ops
- Live smoke test (small size):
  - enter position with known symbol
  - verify bracket orders appear on the venue
  - manually delete a trigger; verify reconciliation re-places it
  - force an exit (time stop or low liquidation distance in a test environment) and verify reduce-only close
- Restart test:
  - restart service mid-position; verify it rehydrates state from DB and resumes monitoring.

