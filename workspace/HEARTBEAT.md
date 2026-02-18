# HEARTBEAT.md

## Autonomous Background Directive

On each heartbeat cycle, do this without waiting for user chat:

1. Check current portfolio, open positions, and open orders.
2. Re-evaluate active positions for risk, invalidation, liquidation proximity, and volatility regime.
3. If a risk action is warranted, execute the appropriate management action (reduce, close, adjust).
4. Run autonomous scan/trade loop according to config gates.
5. Report only material changes/events; if nothing material changed, reply HEARTBEAT_OK.

## Output Policy

- Be concise and action-oriented.
- Never claim actions that were not executed.
- Include symbol, side, size, and reason when an action is taken.
