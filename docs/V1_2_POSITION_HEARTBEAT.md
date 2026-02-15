# v1.2: Position Heartbeat (Essential)

## Summary
Position Heartbeat is a background risk-management loop that continues operating between user messages. It polls venue state, detects tail-risk triggers, and can take limited, risk-reducing actions (tighten stop, partial close, full close, adjust take-profit) without waiting for chat input.

On `main`, this is implemented as `PositionHeartbeatService` (`src/core/position_heartbeat.ts`) and started by the gateway when `heartbeat.enabled: true` (`src/gateway/index.ts`).

## Why This Matters
Without a heartbeat loop, the system is effectively blind between user interactions and cannot reliably:
- Detect liquidation proximity fast enough.
- Detect missing/stale stop orders.
- React to funding flips/spikes and volatility spikes.
- Enforce time ceilings or reduce exposure after large PnL shifts.

## Goals (v1.2)
- Always-on monitoring while positions are open.
- Fast, deterministic “hard circuit breakers” for extreme risk.
- Optional LLM-mediated decisions for non-emergency adjustments.
- All actions are risk-reducing only (no adds, no widening stops).
- Durable journaling of every decision (for audit + debugging).

## Non-Goals
- Alpha generation. Heartbeat is for risk control, not trade discovery.
- Complex portfolio optimization. Keep logic local per position.
- “Human-like” narrative; actions should be mechanical and auditable.

## Implementation On `main` (What Exists Today)

### Runtime Architecture
`PositionHeartbeatService`:
- Runs on a dynamic schedule:
  - Fast cadence while positions are open: `tickIntervalSeconds`
  - Slow cadence while flat: `max(60, tickIntervalSeconds * 5)`
- Layer 1: Polling (Hyperliquid)
  - `getClearinghouseState()`
  - `getAllMids()`
  - `getOpenOrders()` (best-effort; used for SL/TP parsing)
  - Funding rates via `getMetaAndAssetCtxs()` (best-effort)
  - Transport retries via `retryWithBackoff(...)`
- Layer 2: Trigger evaluation
  - Rolling buffer per symbol (`rollingBufferSize`)
  - Trigger state per symbol with cooldowns: `TriggerState` + `evaluateHeartbeatTriggers(...)` (`src/core/heartbeat_triggers.ts`)
- Layer 2.5: Hard circuit breakers (no LLM)
  - Emergency close if:
    - `distToLiquidationPct < 2`
    - `pnlPctOfEquity < -5`
- Layer 3: LLM action selection (rate-limited)
  - Per-hour call window: `maxCallsPerHour`
  - Prompt includes: triggers fired, current position summary, SL/TP distances, liquidation distance, funding rate, and a recent trajectory table.
  - Output must be JSON and is validated (`validateAction(...)`).

### Allowed Actions (Risk-Reducing Only)
The LLM is constrained by a system prompt:
- Must not increase risk.
- Must not widen stop-loss.
- Must not add to position size.

Actions:
- `hold`
- `tighten_stop` (replace SL trigger)
- `adjust_take_profit` (replace TP trigger)
- `take_partial_profit` (reduce-only market close for a fraction/size)
- `close_entirely` (reduce-only market close)

Execution primitives:
- Reduce-only close: `executeToolCall('perp_place_order', {..., reduce_only: true, order_type: 'market'})`
- Replace trigger order:
  - Best-effort cancel existing oid via `perp_cancel_order`
  - Place new Hyperliquid trigger order directly via `HyperliquidClient.getExchangeClient().order(...)`

### Journaling / Audit
Every tick outcome is recorded via `recordPositionHeartbeatDecision(...)` (`src/memory/position_heartbeat_journal.ts`) with:
- `symbol`, `timestamp`
- `triggers` (names)
- `decision` (action + reason)
- `snapshot` (tick + tool result / validation / errors)
- `outcome`: `ok | failed | rejected | skipped | info`

### Configuration Surface (On `main`)
Defined in `config/default.yaml` and validated in `src/core/config.ts`:
```yaml
heartbeat:
  enabled: false
  tickIntervalSeconds: 30
  rollingBufferSize: 60
  triggers:
    pnlShiftPct: 1.5
    approachingStopPct: 1.0
    approachingTpPct: 1.0
    liquidationProximityPct: 5.0
    fundingSpike: 0.0001
    volatilitySpikePct: 2.0
    volatilitySpikeWindowTicks: 10
    timeCeilingMinutes: 15
    triggerCooldownSeconds: 180
  llm:
    provider: null
    model: null
    maxTokens: 1024
    maxCallsPerHour: 20
```

## How This Fits Into v1.1 (Backport Plan)
v1.1 can integrate this with minimal coupling by keeping heartbeat as a gateway-level service that only depends on:
- `ToolExecutorContext` (to call `perp_place_order` / `perp_cancel_order`)
- Hyperliquid read APIs (positions, mids, open orders)
- A journal sink (SQLite table or file log)

### Minimal v1.1 Requirements
- Live trading must already work end-to-end for `perp_place_order` reduce-only.
- Hyperliquid credentials must be present on the server (private key + account address).
- A polling client must be available (`HyperliquidClient` or equivalent).

### Integration Steps (v1.1 -> v1.2)
1. Add `heartbeat:` config block (and schema validation) identical to `main`.
2. Instantiate `PositionHeartbeatService` in the gateway after the agent is constructed:
   - Use the agent’s shared `toolContext` so heartbeat uses the same execution adapter + limits.
3. Add journaling:
   - Prefer SQLite-backed `position_heartbeat_journal` (as on `main`) for auditability.
4. Safety defaults:
   - `heartbeat.enabled: false` by default
   - Hard circuit breakers always active when heartbeat is enabled.

### Interaction With Trade Management (Optional In v1.1, Better In v1.2)
On `main`, heartbeat attempts to load a “thesis” for the position from the open Trade Envelope (`trade-management/db`). In v1.1, if envelopes don’t exist yet:
- Keep thesis as `null` (the heartbeat still works).
- Optionally store a short thesis string per symbol on entry (even without full trade-management).

## Testing & Ops
- Unit test trigger evaluation (`src/core/heartbeat_triggers.ts`) deterministically.
- Unit test JSON parsing/validation for LLM actions.
- Integration smoke test in live mode:
  - Open a tiny position, verify heartbeat:
    - detects `stop_missing`
    - can place/replace SL/TP trigger orders
    - can reduce-only close.

