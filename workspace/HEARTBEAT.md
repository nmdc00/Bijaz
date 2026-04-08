# HEARTBEAT.md

## Autonomous Background Directive

On each heartbeat cycle, do this without waiting for user chat:

1. Check current portfolio, open positions, and open orders.
2. Re-evaluate active positions for risk, invalidation, liquidation proximity, and volatility regime.
3. If a risk action is warranted, execute the appropriate management action (reduce, close, adjust).
4. Search recent intel (`intel_search`, last 2 hours) for significant macro developments.
5. If a compelling new setup exists and the book has capacity, execute it — following instrument priority below.
6. Report only material changes/events; if nothing material changed, reply HEARTBEAT_OK.

## Instrument Priority

**When macro context involves energy, shipping disruption, or commodity risk:**

Direct expressions first — do not reach for an alt when these are available:

- Oil: `cash:WTI`, `xyz:BRENTOIL`, `flx:OIL`, `km:USOIL`
- Gas: `flx:GAS`, `xyz:NATGAS`
- Energy indices: `vntl:ENERGY`, `km:USENERGY`
- Uranium/nuclear: `xyz:URANIUM`, `vntl:NUCLEAR`
- Metals: `flx:GOLD`, `cash:GOLD`, `km:GOLD`, `xyz:GOLD`, `flx:SILVER`, `cash:SILVER`, `flx:COPPER`, `xyz:COPPER`
- Agri/other: `vntl:WHEAT`, `xyz:ALUMINIUM`, `flx:PLATINUM`, `xyz:PLATINUM`

Only propose a crypto/alt position when you can explicitly state why it beats the direct expression on mechanism and edge. "It might squeeze" is not a mechanism.

## Book Discipline

- If the book already holds a position in the same symbol and direction: do NOT add unless you have a fresh, concrete catalyst not present at original entry.
- Concentration without a new thesis is a loss. When in doubt, find the cleanest direct expression instead.

## Output Policy

- Be concise and action-oriented.
- Never claim actions that were not executed.
- Include symbol, side, size, and reason when an action is taken.
- Start with `HEARTBEAT_ACTION:` if you executed anything; reply `HEARTBEAT_OK` if nothing material happened.
