# Thufir Hawat

Thufir is an autonomous market discovery and trading assistant focused on crypto/perps workflows (with Hyperliquid live support), persistent memory, calibration analytics, and multi-channel operation (CLI, Telegram, WhatsApp).

## Current State

- Primary use case: market discovery, trade decision support, and controlled autonomous execution
- Execution modes: `paper`, `webhook`, `live` (Hyperliquid)
- Channels: CLI, Telegram, WhatsApp
- Agent stack: conversational chat, orchestrator mode, mentat fragility scans, delphi prediction workflows
- Proactive capabilities: scheduled proactive search + time-sensitive proactive refresh gate in chat

## Key Features

- Autonomous scan loop with configurable safety/risk limits
- Hyperliquid live trading support with guardrails
- Persistent memory (chat, trades, journals, incidents, playbooks)
- Calibration statistics and Delphi calibration reporting
- Intel ingestion and search (RSS/NewsAPI/Google News/Twitter where configured)
- Scheduler control plane + notification hooks (briefing, intel fetch/alerts, heartbeat, mentat)
- Session-aware and context-enriched discovery pipeline

## Requirements

- Node.js `22.0.0`
- `pnpm` `9.x`

## Quick Start

```bash
git clone git@github.com:nmdc00/Thufir-Hawat.git
cd Thufir-Hawat
pnpm install
cp config/default.yaml ~/.thufir/config.yaml
```

Set required env vars (example):

```bash
export ANTHROPIC_API_KEY="..."
# or when using OpenAI provider
export OPENAI_API_KEY="..."
```

Run gateway:

```bash
pnpm gateway
```

Run CLI:

```bash
pnpm thufir --help
```

## Configuration

Main config path:

- `~/.thufir/config.yaml`
- Base template: `config/default.yaml`

Important sections:

- `agent`: model/provider/tooling/orchestrator settings
- `execution`: `paper|webhook|live`
- `autonomy`: scan cadence, strategy limits, full-auto toggle
- `wallet`: spending/risk limits
- `notifications`: schedulers and alerting
- `intel`: source + embeddings config

### Proactive Refresh Gate (time-sensitive answers)

```yaml
agent:
  proactiveRefresh:
    enabled: false
    intentMode: time_sensitive  # off | time_sensitive | always
    ttlSeconds: 900
    maxLatencyMs: 4500
    marketLimit: 20
    intelLimit: 5
    webLimit: 5
    strictFailClosed: true
    fundingSymbols: [BTC, ETH]
```

When enabled, time-sensitive prompts trigger a pre-answer refresh and responses include `as_of` and source attribution.

## Core CLI Commands

### Environment

```bash
thufir env init
thufir env check
thufir env verify-live --symbol BTC
```

### Wallet

```bash
thufir wallet create
thufir wallet import
thufir wallet status
thufir wallet limits show
thufir wallet limits set --daily 100 --per-trade 25 --confirmation-threshold 10
```

### Markets and Portfolio

```bash
thufir markets list
thufir markets show BTC
thufir markets sync --limit 200
thufir markets watch BTC
thufir markets watchlist
thufir portfolio
```

### Intel

```bash
thufir intel status
thufir intel search "btc etf"
thufir intel recent --limit 20
thufir intel alerts --limit 20
thufir intel fetch
thufir intel proactive --max-queries 8 --iterations 2
thufir intel proactive-stats --limit 20
```

### Agent / Analysis

```bash
thufir chat
thufir agent run --mode trade "Evaluate BTC setup and propose action"
thufir analyze BTC
thufir ask "macro risks this week"
thufir top10
thufir briefing
thufir mentat scan --system Hyperliquid --market-limit 20
thufir mentat report --system Hyperliquid --market-limit 20
```

### Delphi / Calibration / PnL

```bash
thufir delphi help
thufir delphi run --symbol BTC --horizon-hours 24 --count 3
thufir calibration show
thufir calibration report
thufir pnl
thufir eval
```

### Autonomy

```bash
thufir auto status
thufir auto on
thufir auto off
thufir auto report
```

### Gateway

```bash
thufir gateway
```

## Telegram / WhatsApp Runtime Commands

Main in-chat commands:

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

## Development

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm test:v1.4:acceptance
./scripts/v1.4-smoke.sh
```

## Project Layout

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
tests/
scripts/
```

## Security Notes

- Use dedicated low-balance wallets for live trading
- Keep `THUFIR_WALLET_PASSWORD` and API keys out of git
- Validate risk limits before enabling full auto
- Prefer paper mode for strategy validation first

## Related Docs

- `docs/ARCHITECTURE.md`
- `docs/WALLET_SECURITY.md`
- `docs/INTEL_SOURCES.md`
- `docs/CALIBRATION.md`
- `release/v1.4.md`
- `release/v1.5.md`
