# Thufir Development Progress

**Last Updated:** 2026-02-16

## Current Status
`release/v1.2` is now focused on live-safe execution and collateral operability: position heartbeat + trade-management risk controls are merged, autonomous trade mode bugs are fixed, and Hyperliquid collateral movement is now exposed through agent tools with dex-abstraction-aware USDC handling.

## Completed
- Hyperliquid market client (list/get symbols, mark price, metadata)
- Live executor for Hyperliquid perps
- Perp risk checks (max notional, leverage caps, liquidation distance, correlation caps)
- Discovery engine (signals -> hypotheses -> expressions)
- Autonomous execution thresholds now enforced (`minEdge`, `requireHighConfidence`, `pauseOnLossStreak`)
- Technical on-chain snapshot now computes live score from Hyperliquid funding/orderflow/book data
- Perp tools (`perp_market_list`, `perp_market_get`, `perp_place_order`, `perp_open_orders`, `perp_cancel_order`, `perp_positions`)
- Portfolio now surfaces perp positions
- User-facing prompts updated away from legacy market flows
- CLI and docs updated to remove legacy market commands
- Full test suite passing in this branch (`32` files / `99` tests)
- TypeScript build passing in this branch
- Coverage configuration hardened (vendor-remap exclusions + minimum thresholds)
- Live verification tools added:
  - `hyperliquid_verify_live` (read-only smoke check + authenticated readiness checks)
  - `hyperliquid_order_roundtrip` (authenticated place+cancel roundtrip)
- Funding remediation tools added for Hyperliquid collateral blockers:
  - `evm_usdc_balances` (Polygon/Arbitrum probe)
  - `cctp_bridge_usdc` (Polygon <-> Arbitrum USDC via CCTP v1)
  - `hyperliquid_deposit_usdc` (transfer Arbitrum USDC to HL bridge deposit address)
- Lint gate fixed (`pnpm lint` now runs against TypeScript sources with project ESLint config)
- Reflexivity detector (crowding + fragility + catalyst):
  - Catalyst registry support (`config/catalysts.yaml`)
  - Narrative snapshot extraction with decision-artifact caching (optional LLM JSON mode)
  - Reflexivity fragility scoring wired into discovery as `reflexivity_fragility` signal
  - Setup artifacts persisted (`reflexivity_setup_v1`)
- v1.2 risk-control foundations merged:
  - Position heartbeat service with trigger evaluation + emergency close coverage
  - Trade-management monitor with exchange-native bracket lifecycle support
- Autonomous execution reliability fixes:
  - Fixed three blocking bugs in trade-mode detection and dynamic tool inputs
  - Fixed GPT tool-name mangling via substring extraction
  - Allow reduce-only orders to bypass spending-limiter checks
- Conversation/orchestration behavior tightened:
  - Trade-intent flow now includes `perp_market_list` snapshot
  - Falls through to orchestrator when autonomous scan returns no candidates
- Hyperliquid collateral and transfer workflow upgraded:
  - Added `hyperliquid_usd_class_transfer` tool in conversation layer + agent adapter
  - Added `usdClassTransfer` execution path and clarified spot/perp/on-chain USDC semantics in portfolio output
  - Detects dex abstraction and treats unified spot USDC as collateral
  - Falls back to spot USDC when perp withdrawable balance is zero
- Added/updated test coverage for:
  - trade-intent tool snapshots
  - hyperliquid USD class transfer
  - dex abstraction collateral handling

## In Progress
- Real-account verification rollout:
  - deploy updated code to the running server process
  - restart gateway to pick up `.env` changes
  - ensure Arbitrum ETH is available for gas (required for CCTP receive + deposit transfer)
- v1.2 release hardening:
  - run full live smoke checks for transfer + collateral flows under both unified and split-account setups
  - verify heartbeat/trade-management behavior against tiny live positions
- Optional expansion of on-chain providers (e.g. Coinglass/Whale APIs)
- Reflexivity follow-ups:
  - wire thesis invalidation evaluation into the autonomy loop (exit-on-thesis-break)
  - improve carry-cost modeling and catalyst binding requirements before auto-exec

## Next Steps
1. Deploy `release/v1.2` build and restart gateway service with latest env/config
2. Run `hyperliquid_verify_live`, `hyperliquid_order_roundtrip`, and `hyperliquid_usd_class_transfer` with minimal safe sizing
3. Validate portfolio semantics across spot/perp/on-chain balances for both dex abstraction modes
4. If collateral missing: run `evm_usdc_balances` -> `cctp_bridge_usdc` -> `hyperliquid_deposit_usdc` (requires Arbitrum ETH gas)
