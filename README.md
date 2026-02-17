# Thufir - Autonomous Crypto Trading Agent

Thufir is an autonomous trading and market-discovery agent for crypto/perps, with Hyperliquid live execution support, persistent memory, policy-gated automation, and multi-channel operation.

Named after the Mentat of House Atreides: a strategist that synthesizes noisy information into actionable decisions.

Built on a Clawdbot-inspired multi-channel architecture. Written in TypeScript. Operates via CLI, Telegram, and WhatsApp.

## What Makes Thufir Different

Most systems are either:

- Fully mechanical: disciplined but blind to narrative/context shifts
- Fully discretionary LLM: flexible but prone to rationalization and risk drift

Thufir separates responsibilities:

- LLM/reasoning layer: thesis formation, market context synthesis, and opportunity selection
- Policy/execution layer: deterministic risk gates, sizing constraints, and enforcement controls

This design keeps adaptive reasoning while preserving hard risk discipline.

## Core Architecture

```text
┌──────────────────────────────────────────────────┐
│               TELEGRAM / WHATSAPP / CLI          │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│                    GATEWAY                        │
│         Sessions │ Routing │ Schedules │ Auth     │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│                  AGENT CORE                       │
│   LLM Reasoning │ Autonomy Policy │ Trade Mgmt    │
└────────┬───────────┬──────────────┬──────────────┘
         │           │              │
    ┌────▼────┐ ┌────▼─────┐ ┌─────▼──────┐
    │  INTEL  │ │  MEMORY  │ │ EXECUTION  │
    │─────────│ │──────────│ │────────────│
    │ RSS     │ │ Journal  │ │ Hyperliquid│
    │ NewsAPI │ │ Signals  │ │ Perps      │
    │ Google  │ │ Policy   │ │ Risk Gates │
    │ Twitter │ │ State    │ │ TP/SL Mgmt │
    └─────────┘ └──────────┘ └────────────┘
```

## Key Systems

### 1) Autonomy Policy Engine

Deterministic gates for execution quality and risk:

- Regime-aware policy filtering
- Signal performance thresholds (`minSharpe`, `minSamples`)
- Calibration-aware downweight/block controls
- Trade caps per scan/day
- Pause-on-loss-streak logic

### 2) Trade Management

Mechanical position supervision with exchange-native and polling controls:

- Configurable TP/SL/time-stop defaults
- Active monitoring cadence when positions are open
- Liquidation guardrails
- Journaled outcomes and post-trade metadata

Note: behavior is policy-constrained; full autonomy must be explicitly enabled.

### 3) Intel + Proactive Search

- RSS/NewsAPI/Google News/Twitter (when configured)
- Stored intel search and alerting
- Iterative proactive search with learned query ranking
- Optional proactive refresh gate for time-sensitive answers (`as_of` + source attribution)

### 4) Learning Loop

Persistent SQLite-backed artifacts:

- Trade journals and execution metadata
- Calibration summaries and reports
- Incidents/playbooks/policy state
- Session memory for conversational context continuity

## Quick Start

### Prerequisites

- Node.js `22.0.0`
- `pnpm` `9.x`
- Anthropic or OpenAI API key
- Hyperliquid private key (live mode only)

### Install

```bash
git clone git@github.com:nmdc00/Thufir-Hawat.git
cd Thufir-Hawat
pnpm install
cp config/default.yaml ~/.thufir/config.yaml
```

### Set Environment

```bash
export ANTHROPIC_API_KEY="..."
# or
export OPENAI_API_KEY="..."

# live mode only
export HYPERLIQUID_PRIVATE_KEY="0x..."
```

### Run

```bash
# verify live connectivity (read-only)
pnpm thufir env verify-live --symbol BTC

# start gateway
pnpm gateway

# CLI help
pnpm thufir --help
```

## Configuration Reference

Primary file: `~/.thufir/config.yaml` (from `config/default.yaml`)

### Execution

```yaml
execution:
  mode: paper      # paper | webhook | live
  provider: hyperliquid
```

### Hyperliquid

```yaml
hyperliquid:
  maxLeverage: 5
  defaultSlippageBps: 10
  symbols: [BTC, ETH]
```

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

### Autonomy

```yaml
autonomy:
  enabled: true
  fullAuto: false
  scanIntervalSeconds: 900
  maxTradesPerScan: 3
  maxTradesPerDay: 25
  minEdge: 0.05
  pauseOnLossStreak: 3
  signalPerformance:
    minSharpe: 0.8
    minSamples: 8
```

### Proactive Refresh Gate

```yaml
agent:
  proactiveRefresh:
    enabled: false
    intentMode: time_sensitive   # off | time_sensitive | always
    ttlSeconds: 900
    maxLatencyMs: 4500
    strictFailClosed: true
    fundingSymbols: [BTC, ETH]
```

## Command Surface

### CLI

```bash
# environment
thufir env init
thufir env check
thufir env verify-live --symbol BTC

# wallet + risk limits
thufir wallet create
thufir wallet import
thufir wallet status
thufir wallet limits show

# markets + portfolio
thufir markets list
thufir markets show BTC
thufir markets sync --limit 200
thufir portfolio

# intel
thufir intel status
thufir intel search "btc funding"
thufir intel recent --limit 20
thufir intel fetch
thufir intel proactive --max-queries 8 --iterations 2

# analysis + agentic
thufir chat
thufir analyze BTC
thufir ask "macro setup this week"
thufir top10
thufir mentat scan --system Hyperliquid
thufir delphi run --symbol BTC --horizon-hours 24 --count 3

# autonomy controls
thufir auto status
thufir auto on
thufir auto off
thufir auto report

# gateway
thufir gateway
```

### Telegram / WhatsApp Commands

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
- `/analyze-json <symbol>`
- `/fullauto on|off`
- `/pause` and `/resume`
- `/profile`
- `/setpref key=value`

## Deployment

### Hetzner / Ubuntu (scripted)

```bash
bash scripts/install_hetzner.sh
```

### Manual VPS

```bash
pnpm install
cp config/default.yaml ~/.thufir/config.yaml
# edit config + set env vars
pnpm gateway
```

## Project Structure

```text
src/
  agent/
  core/
  discovery/
  execution/
  gateway/
  intel/
  memory/
  mentat/
  delphi/
  trade-management/
config/
release/
scripts/
tests/
workspace/
```

## Security

- Keep private keys in environment variables, never in committed config
- Use conservative daily/per-trade limits before enabling `fullAuto`
- Prefer paper mode for strategy validation
- Monitor policy blocks and trade journal outcomes continuously

## Development

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm test:v1.4:acceptance
./scripts/v1.4-smoke.sh
```

## License

MIT - see `LICENSE`

## Disclaimer

Trading perpetual futures carries significant risk, including total loss of capital. This project is for research and engineering use. Nothing here is financial advice.
