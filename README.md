# Thufir

Thufir is an autonomous crypto/perps trading agent built around one idea: let the LLM reason about market context and trade thesis, but keep execution, sizing, and risk controls deterministic.

The current codebase runs through a gateway process, supports CLI/Telegram/WhatsApp, persists state in SQLite, and targets Hyperliquid for perp trading. Paper mode is the default.

## Current Model

Thufir is not a pure rules engine and not a pure chat trader.

- Discovery, trade thesis, and narrative judgment can use LLM reasoning.
- Execution gates, sizing caps, journal writes, and most risk controls are deterministic.
- Open-position management now has a coherence loop from `v1.97`:
  - `PositionBook` tracks open positions in shared in-memory state.
  - `LlmEntryGate` can approve, reject, or resize new trades before execution.
  - `LlmExitConsultant` can re-evaluate open positions during heartbeat ticks.
  - `PositionHeartbeatService` still enforces mechanical trigger paths even when LLM consultation is disabled.

## Architecture

```text
Channels (CLI / Telegram / WhatsApp)
  -> Gateway
    -> Agent
      -> AutonomousManager
      -> ConversationHandler
      -> TradeManagementService
      -> PositionHeartbeatService
    -> Memory (SQLite journals/state)
    -> Intel / Search / Market data
    -> Execution adapters (paper / live Hyperliquid / webhook)
```

Key runtime pieces:

- `src/gateway/index.ts`: process entrypoint, channel wiring, schedulers, heartbeat startup
- `src/core/agent.ts`: agent assembly and LLM client accessors
- `src/core/autonomous.ts`: scan loop, policy filters, entry gate, execution
- `src/core/position_heartbeat.ts`: polling-based position supervision and exit actions
- `src/core/position_book.ts`: shared open-position view used by entry/exit coherence logic
- `src/trade-management/`: exchange-native risk controls and stop management
- `src/memory/`: SQLite-backed journals, policy state, sessions, alerts, artifacts

## What `v1.97` Added

- Shared `PositionBook` state for open positions
- LLM entry gating before autonomous execution
- LLM exit consultation during heartbeat supervision
- Config switches to disable either LLM path without removing the mechanical loop
- Acceptance coverage for fallback behavior and toggle behavior

This matters because the system now has a tighter feedback loop between:

1. why a trade was opened
2. what other positions are already live
3. whether new trades conflict with the existing book
4. whether an open thesis still makes sense as market context changes

## Quick Start

### Prerequisites

- Node.js `22.x`
- `pnpm` `9.x`
- one of:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
- for live Hyperliquid trading only:
  - `HYPERLIQUID_PRIVATE_KEY`

### Install

```bash
git clone git@github.com:nmdc00/Thufir-Hawat.git
cd Thufir-Hawat
pnpm install
cp config/default.yaml ~/.thufir/config.yaml
```

### Run

```bash
pnpm thufir --help
pnpm thufir gateway
```

Useful commands:

```bash
pnpm thufir env verify-live --symbol BTC
pnpm thufir auto status
pnpm thufir intel search "btc funding"
pnpm thufir mentat scan --system Hyperliquid
```

## Configuration

Primary config file: `~/.thufir/config.yaml`

Reference defaults live in [config/default.yaml](/home/nmcdc/projects/Thufir-Hawat/config/default.yaml).

### Execution Mode

```yaml
execution:
  mode: paper      # paper | webhook | live
  provider: hyperliquid
```

### Autonomous Scan

```yaml
autonomy:
  enabled: false
  fullAuto: false
  scanIntervalSeconds: 900
  maxTradesPerScan: 3
  maxTradesPerDay: 25
  minEdge: 0.05
  pauseOnLossStreak: 3
```

### LLM Entry Gate

```yaml
autonomy:
  llmEntryGate:
    enabled: true
    timeoutMs: 5000
    rejectOnBothFail: true
```

Meaning:

- `enabled`: skip the LLM gate entirely when `false`
- `timeoutMs`: timeout for each gate call
- `rejectOnBothFail`: if both primary and fallback LLM calls fail, reject by default when `true`

### Position Heartbeat + LLM Exit Consult

```yaml
heartbeat:
  enabled: true
  tickIntervalSeconds: 30
  rollingBufferSize: 60
  triggers:
    pnlShiftPct: 1.5
    liquidationProximityPct: 5.0
    volatilitySpikePct: 2.0
    volatilitySpikeWindowTicks: 10
    timeCeilingMinutes: 0
    triggerCooldownSeconds: 180
  llmExitConsult:
    enabled: true
    firstConsultMinutes: 20
    cadenceMinutes: 20
    roeThresholds: [3, 7, 15]
    approachTtlMinutes: 15
    timeoutMs: 8000
```

Meaning:

- heartbeat triggers still enforce mechanical exits/reductions
- `timeCeilingMinutes: 0` disables the generic max-hold close so thesis time stops and the exit consultant govern duration
- `llmExitConsult.enabled: false` keeps the rules-only heartbeat path
- the consultant can be triggered by time held, ROE threshold crossings, or thesis TTL approach

### Trade Management

```yaml
tradeManagement:
  enabled: false
  defaults:
    stopLossPct: 3.0
    takeProfitPct: 5.0
    maxHoldHours: 72
  monitorIntervalSeconds: 900
  activeMonitorIntervalSeconds: 60
  useExchangeStops: true
  liquidationGuardDistanceBps: 800
```

### Proactive Refresh

```yaml
agent:
  proactiveRefresh:
    enabled: false
    intentMode: time_sensitive   # off | time_sensitive | always
    ttlSeconds: 900
    maxLatencyMs: 4500
    strictFailClosed: true
```

## Command Surface

### CLI

```bash
thufir env verify-live --symbol BTC
thufir wallet status
thufir portfolio
thufir intel search "btc funding"
thufir intel fetch
thufir chat
thufir ask "macro setup this week"
thufir mentat scan --system Hyperliquid
thufir delphi run --symbol BTC --horizon-hours 24 --count 3
thufir auto status
thufir auto report
thufir gateway
```

### Gateway / Chat Commands

- `/help`
- `/status`
- `/report`
- `/briefing`
- `/intel`
- `/watch <symbol>`
- `/watchlist`
- `/scan`
- `/delphi ...`
- `/perp <symbol> <buy|sell> <sizeUsd> [leverage]`
- `/markets <query>`
- `/analyze <symbol>`
- `/fullauto on|off`
- `/pause`
- `/resume`

## Deployment

### Local / VPS

```bash
pnpm install
cp config/default.yaml ~/.thufir/config.yaml
pnpm thufir gateway
```

### Server Pattern Used In Production

- systemd service runs `pnpm thufir gateway`
- config path is injected with `THUFIR_CONFIG_PATH`
- repo is built in place with:

```bash
bash scripts/update.sh
```

That script expects the server checkout to be on the intended branch and able to fast-forward cleanly.

## Project Layout

```text
src/
  agent/
  core/
  delphi/
  discovery/
  execution/
  gateway/
  intel/
  markets/
  memory/
  mentat/
  trade-management/
config/
docs/
scripts/
tests/
```

## Development

Standard checks:

```bash
pnpm typecheck
pnpm vitest run
```

If the suite is sharing a stale DB path, isolate it explicitly:

```bash
THUFIR_DB_PATH=/tmp/thufir-test.sqlite pnpm vitest run
```

## Safety Notes

- Do not enable `fullAuto` with loose wallet limits.
- Keep live mode off until paper behavior is stable.
- Do not store private keys in committed config.
- Review Telegram/gateway exposure carefully before binding outside loopback.

## License

MIT. See `LICENSE`.

## Disclaimer

Trading perpetual futures can result in total loss. This repository is engineering software, not financial advice.
