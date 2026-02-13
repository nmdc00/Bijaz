# Thufir Hawat

Autonomous market discovery + execution companion (initial venue: **Hyperliquid perps**).

Thufir is designed to:
- scan markets for pressure/fragility
- form hypotheses and map them to trade expressions
- execute probe-sized trades under strict risk limits (paper/webhook/live)
- keep artifacts (intel, tool traces, evaluation) so the system can learn and be audited

If you want the design north-star, start with `THUFIR_HAWAT_AUTONOMOUS_MARKET_DISCOVERY.md`.

## Status

The Hyperliquid perps stack, discovery loop, and agentic orchestration are implemented.
Implementation status is tracked in `docs/PROGRESS.md`.

## Quick Start (Dev)

### Prereqs
- Node.js 22
- pnpm

### Install
```bash
pnpm install
```

### Config (Required)
The CLI loads config at startup. Create the default config file first:
```bash
mkdir -p ~/.thufir
cp config/default.yaml ~/.thufir/config.yaml
```

### Secrets (.env)
Create/update a local `.env` and optionally run API checks:
```bash
pnpm thufir env init
pnpm thufir env check
```

### Run
Start the gateway:
```bash
pnpm thufir gateway
```

Or use the CLI directly:
```bash
pnpm thufir chat "Scan BTC/ETH perps for fragility setups."
pnpm thufir top10
pnpm thufir mentat scan
```

## Live Mode (Hyperliquid)

1. Set Hyperliquid credentials in your environment:
```bash
export HYPERLIQUID_PRIVATE_KEY="0x..."
export HYPERLIQUID_ACCOUNT_ADDRESS="0x..." # required for authenticated checks
```

2. Update `~/.thufir/config.yaml`:
```yaml
execution:
  mode: live # paper | webhook | live
```

3. Run read-only and authenticated checks:
```bash
pnpm thufir env verify-live --symbol BTC

# Side-effecting: places a tiny far-off limit order then cancels (will prompt).
pnpm thufir agent run --mode trade "Run hyperliquid_order_roundtrip for BTC size=0.001" --show-tools --show-plan
```

Security note: live mode is real money. Read `docs/WALLET_SECURITY.md` before funding a hot wallet.

## CLI Reference

Use `pnpm thufir --help` and `pnpm thufir <command> --help`.

```bash
# Environment
pnpm thufir env init
pnpm thufir env check
pnpm thufir env verify-live --symbol BTC

# Wallet
pnpm thufir wallet create
pnpm thufir wallet import
pnpm thufir wallet status
pnpm thufir wallet limits show
pnpm thufir wallet limits set --daily 100 --per-trade 25 --confirmation-threshold 10

# Markets
pnpm thufir markets list
pnpm thufir markets show <id>
pnpm thufir markets watch <id>
pnpm thufir markets watchlist
pnpm thufir markets sync --limit 200

# Portfolio / evaluation / calibration
pnpm thufir portfolio
pnpm thufir calibration show
pnpm thufir pnl
pnpm thufir eval

# Intel
pnpm thufir intel status
pnpm thufir intel search <query>
pnpm thufir intel recent --limit 20
pnpm thufir intel alerts --limit 50
pnpm thufir intel fetch
pnpm thufir intel proactive --max-queries 8
pnpm thufir intel proactive-stats --limit 20

# Agentic orchestration
pnpm thufir agent run --mode chat "Find crowded perps setups on Hyperliquid."
pnpm thufir agent run --mode trade "Propose and place a probe trade on BTC if edge >= 0.06."

# Analysis & reporting
pnpm thufir analyze <market>
pnpm thufir briefing
pnpm thufir ask <topic...>
pnpm thufir top10
pnpm thufir mentat scan
pnpm thufir mentat report

# Autonomy
pnpm thufir auto status
pnpm thufir auto on
pnpm thufir auto off
pnpm thufir auto report

# User / memory / debug
pnpm thufir user show <id>
pnpm thufir user set <id> --domains crypto,macro --risk moderate --pref timezone=EST
pnpm thufir memory sessions
pnpm thufir memory show <userId> -l 50
pnpm thufir memory compact <userId>
pnpm thufir memory prune --days 90
pnpm thufir debug whoami

# TA + signals
pnpm thufir ta <symbol>
pnpm thufir signals
pnpm thufir strategy <name>
```

## Development

```bash
pnpm dev
pnpm build
pnpm test                 # watch
pnpm exec vitest run      # CI-style
pnpm lint
pnpm typecheck
```

## Docs

See `docs/README.md` for an index.

## Contributing

See `CONTRIBUTING.md`.

## Security

See `SECURITY.md` and `docs/WALLET_SECURITY.md`.

## License

MIT. See `LICENSE`.
