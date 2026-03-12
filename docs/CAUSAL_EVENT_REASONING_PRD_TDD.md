# Causal Event Reasoning (General Trader Pivot): PRD + TDD

Last updated: 2026-03-12

## Context
Thufir's current intelligence loop can ingest news, search the web, persist intel, and reason about markets, but it is still shaped around crypto/perp execution. The next step is not "more news." It is a new internal reasoning loop that converts external events into causal market hypotheses, tracks whether those hypotheses worked, and reuses that history on future events.

This doc defines an event-driven causal reasoning system that lets Thufir evolve from a crypto-native trader into a general trader. The design is domain-aware but domain-agnostic at the architecture level: crypto, commodities, macro, rates, FX, and equities should all fit the same event -> mechanism -> consequence pattern.

The core operating unit is:

`event -> thought -> forecast -> outcome -> learning`

---

# PRD

## Goal
Enable Thufir to ingest news and other external intelligence, form structured internal thoughts about what happened, infer the causal mechanism linking the event to market consequences, produce trade-relevant hypotheses, and learn from realized outcomes over time.

## Non-goals
- Fully autonomous multi-venue execution across commodities, macro, FX, and equities in this phase.
- Training or fine-tuning a new base model in the MVP.
- Replacing deterministic market data or execution tools with LLM inference.
- Building a full historical training corpus in this doc. Historical-event dataset design will be handled as a follow-up workstream.
- Predicting long-horizon structural fundamentals without an event catalyst.

## Target User
Single operator using Thufir as:
- an event-driven market analyst,
- a hypothesis generator,
- a trader assistant that can eventually operate across domains,
- and a continuously learning system whose past reasoning can be audited.

## Definitions
- **Event**: a normalized representation of one or more incoming intel items that describe the same real-world occurrence.
- **Thought**: a structured internal interpretation of the event, including mechanism, affected assets, direction, timing, and disconfirming conditions.
- **Mechanism**: the transmission path by which the event changes market conditions.
- **Causal chain**: an ordered step sequence from event to market consequence.
- **Forecast**: a concrete directional or regime hypothesis tied to specific assets and time horizons.
- **Outcome**: realized market behavior measured against the forecast after one or more horizons.
- **Learning**: updating confidence in mechanisms, analog retrieval quality, and domain-specific weighting based on outcomes.
- **Domain**: a market family such as crypto, commodities, rates, FX, or equities.

## Product Narrative
When fresh news arrives, Thufir should not stop at summarizing it. He should:
1. identify the distinct event,
2. decide why it matters,
3. infer the market transmission mechanism,
4. identify which assets are first-order and second-order impacted,
5. estimate direction, timing, and confidence,
6. compare the new case to similar past cases,
7. and later score whether the reasoning worked.

The system should accumulate a memory of causal cases rather than just a pile of articles.

## Core Product Requirements

### R1: Normalize Incoming Intel into Distinct Events
The system must convert raw intel items into deduplicated event records.

Each event must include:
- `eventType`
- `title`
- `summary`
- `actors[]`
- `locations[]`
- `domains[]`
- `sourceIntelIds[]`
- `firstSeenAt`
- `lastUpdatedAt`
- `status` (`new|active|resolved|invalidated`)

Requirements:
- Multiple articles describing the same event should merge into one event record.
- Event records must be updatable as new confirming or contradicting intel arrives.
- Event normalization must be deterministic where possible and LLM-assisted only when needed.

### R2: Produce a Structured Internal Thought per Event
For each material event, the system must generate a first-class thought artifact.

Each thought must include:
- `mechanism`
- `causalChain[]`
- `affectedSupplyDemandChannels[]`
- `firstOrderAssets[]`
- `secondOrderAssets[]`
- `expectedDirectionByAsset`
- `expectedMagnitude`
- `timeHorizons[]`
- `confidence`
- `disconfirmingConditions[]`
- `alternativeInterpretations[]`
- `analogCaseIds[]`

Requirements:
- Thoughts must be stored in a queryable, auditable form.
- Thoughts must be versioned so revisions are visible as the event evolves.
- LLM output must be strict JSON and schema-validated.

### R3: Retrieve Historical Analogs Before Finalizing Market Judgment
Before finalizing a thought or forecast, Thufir must retrieve relevant prior cases.

The analog retrieval step must consider:
- event type,
- affected region,
- mechanism similarity,
- impacted asset class,
- regime tags,
- and whether previous analogs succeeded or failed.

Requirements:
- Retrieved analogs must be attached to the thought artifact.
- The system must distinguish between strong analogs and weak analogs.
- Retrieval must work even before the future historical training corpus is complete; early MVP can use live accumulated cases first.

### R4: Emit Explicit Market Hypotheses
Each thought must be able to produce one or more forecast objects that are concrete enough to validate later.

A forecast must include:
- `asset`
- `domain`
- `expectedDirection`
- `expectedMoveType` (`price_up|price_down|vol_up|vol_down|curve_tighten|curve_loosen|spread_widen|spread_tighten|regime_shift`)
- `horizon`
- `confidence`
- `rationale`
- `dependsOn[]`
- `invalidIf[]`

Requirements:
- Forecasts must not be vague summaries.
- Forecasts must carry explicit assumptions and time horizons.
- Forecasts may be tradeable or monitor-only depending on available market/execution support.

### R5: Validate Forecasts Against Realized Outcomes
The system must revisit forecasts after configured horizons and score the result.

Validation must capture:
- direction correctness,
- timing correctness,
- magnitude quality,
- whether the mechanism appeared correct but was dominated by another factor,
- whether the forecast was too late because the move was already priced,
- and whether the thought was invalidated before the horizon.

Requirements:
- Outcome scoring must be mechanical where possible.
- Forecasts without accessible market data should remain unresolved, not fabricated.
- Outcome records must be linked back to both the forecast and the originating event/thought.

### R6: Learn at the Mechanism Level
Learning must occur at the level of mechanisms and conditions, not only asset tickers.

Examples:
- "shipping disruption in a key chokepoint with low spare capacity" may become a stronger bullish oil mechanism.
- "demand shock during already weak macro regime" may become a stronger bearish industrial commodity mechanism.

Requirements:
- The system must track mechanism success/failure statistics over time.
- Learning must be conditioned by regime tags, not just raw event labels.
- The system must support confidence calibration updates for future reasoning.

### R7: Support Domain-Aware Expansion Beyond Crypto
The event reasoning engine must be domain-agnostic, while market validation and execution can remain domain-specific adapters.

Requirements:
- The event/thought/forecast pipeline must work even if the downstream market data source differs by domain.
- Crypto-specific tools like funding/OI skew must become optional enrichments, not mandatory prerequisites.
- Commodities, macro, and other domains must be pluggable through market-context interfaces.

### R8: Preserve Auditability and Operator Trust
Every event-driven conclusion must be auditable.

Requirements:
- The operator must be able to inspect the source intel, thought, analogs, forecast, and scored outcome.
- Thought revisions must not overwrite prior versions silently.
- The system must surface "why I thought this" and "why it failed" artifacts.

## User Stories
- As an operator, I want Thufir to tell me what happened, why it matters, and how that mechanism could move markets.
- As an operator, I want Thufir to form internal market thoughts that can be inspected later instead of ephemeral chat responses.
- As an operator, I want past similar events to influence current reasoning.
- As an operator, I want the system to score itself later so it can improve.
- As an operator, I want this reasoning loop to work for commodities and macro, not only crypto.

## Success Metrics (MVP)
- Event normalization:
  - Duplicate intel items collapse into a smaller set of event records with >70% useful deduplication on active news cycles.
- Thought quality:
  - >80% of material events produce schema-valid thought artifacts without manual repair.
- Forecast discipline:
  - >90% of event-driven outputs include explicit horizon and invalidation conditions.
- Learning loop:
  - Forecast outcomes are evaluated automatically for supported markets on configured horizons.
- Operator trust:
  - Each event-driven conclusion is traceable back to source intel IDs and thought versions.

## Acceptance Criteria
- The system can ingest recent intel and produce at least one normalized event with a linked thought artifact.
- A thought artifact contains mechanism, causal chain, impacted assets, horizons, confidence, and disconfirming conditions.
- A forecast can be created from the thought and stored with explicit validation criteria.
- The system can revisit a forecast later and persist an outcome object.
- The same architecture works for crypto and is not hardcoded to `perp_market_list` or Hyperliquid-only signals.

---

# TDD

## Design Principles
- Prefer deterministic structure for storage, scheduling, validation, and scoring.
- Use the LLM for extraction, synthesis, and analogy only where deterministic rules are insufficient.
- Persist every important reasoning object so the system can learn from history.
- Separate domain-agnostic event reasoning from domain-specific market adapters.
- Keep raw intel, interpreted event, thought, forecast, and outcome as separate linked layers.

## Proposed Pipeline

### Stage 1: Intel Ingestion
Use existing intel and web pipelines to store raw inputs:
- Google News
- NewsAPI
- RSS / web search / fetched pages
- optional social/data feeds

No major conceptual change here; this remains the perception layer.

### Stage 2: Event Extraction
Add an event extraction step that clusters recent intel items into event candidates.

Responsibilities:
- dedupe near-identical headlines,
- merge updates to the same underlying event,
- classify the event type,
- extract actors, geography, and domain tags,
- assign a stable `eventId`.

### Stage 3: Thought Generation
For each high-signal event, generate a structured thought.

Responsibilities:
- infer the mechanism,
- build the causal chain,
- identify directly and indirectly affected assets,
- identify horizon and invalidation conditions,
- attach analogs,
- emit one or more forecasts.

### Stage 4: Forecast Validation
On scheduled horizons, resolve forecasts using market adapters.

Responsibilities:
- load needed market snapshots,
- compare realized behavior against the forecast,
- classify success/failure/partial success,
- write outcome records,
- update mechanism statistics.

### Stage 5: Retrieval and Learning
When new events arrive:
- retrieve past cases,
- weight cases by similarity and past outcome quality,
- feed them into thought generation,
- update domain/mechanism confidence based on later outcomes.

## Proposed Module Layout

- `src/events/types.ts`
  - TypeScript types and validators for events, thoughts, forecasts, and outcomes.
- `src/events/extract.ts`
  - Event normalization, clustering, and update logic.
- `src/events/thoughts.ts`
  - Thought generation orchestration and validation.
- `src/events/analogs.ts`
  - Similar-case retrieval from stored event/thought/outcome records.
- `src/events/outcomes.ts`
  - Forecast resolution and scoring.
- `src/events/scheduler.ts`
  - Scheduling and rehydrating future forecast checks.
- `src/markets/context.ts`
  - Domain-agnostic market context interfaces.
- `src/markets/adapters/crypto.ts`
  - Crypto implementation using existing tools.
- `src/markets/adapters/commodities.ts`
  - Commodity implementation placeholder / future adapter.
- `src/core/proactive_search.ts`
  - Extend query planning to seed event-driven themes by domain.
- `src/core/proactive_refresh.ts`
  - Replace mandatory perp-specific evidence with domain-aware market context.
- `src/core/conversation.ts`
  - Surface event/thought artifacts in tool-first guard and general reasoning.
- `src/memory/schema.sql`
  - Add event/thought/forecast/outcome tables.

## Data Model

### `events`
- `id`
- `event_key`
- `event_type`
- `title`
- `summary`
- `status`
- `domains_json`
- `actors_json`
- `locations_json`
- `source_intel_ids_json`
- `first_seen_at`
- `last_updated_at`
- `created_at`
- `updated_at`

### `event_thoughts`
- `id`
- `event_id`
- `version`
- `schema_version`
- `mechanism`
- `causal_chain_json`
- `channels_json`
- `first_order_assets_json`
- `second_order_assets_json`
- `disconfirming_conditions_json`
- `alternative_interpretations_json`
- `analog_case_ids_json`
- `confidence`
- `reasoning_json`
- `created_at`

### `event_forecasts`
- `id`
- `event_id`
- `thought_id`
- `asset`
- `domain`
- `expected_direction`
- `expected_move_type`
- `horizon_label`
- `horizon_seconds`
- `confidence`
- `depends_on_json`
- `invalid_if_json`
- `rationale`
- `status`
- `created_at`
- `resolve_after`

### `event_outcomes`
- `id`
- `forecast_id`
- `resolved_at`
- `resolution_status`
- `direction_correct`
- `timing_correct`
- `magnitude_score`
- `mechanism_score`
- `priced_in_score`
- `notes`
- `market_snapshot_json`
- `created_at`

### `mechanism_stats`
- `mechanism_key`
- `domain`
- `regime_tags_json`
- `samples`
- `win_rate`
- `direction_accuracy`
- `timing_accuracy`
- `updated_at`

## Schema Notes
- Keep `reasoning_json` and other JSON columns for fast iteration.
- Add narrow indexes on `event_key`, `event_type`, `resolve_after`, `forecast_id`, and `mechanism_key`.
- Use append-style versioning for thoughts rather than destructive updates.

## Interfaces

### Event
```json
{
  "schemaVersion": "1",
  "eventType": "shipping_disruption",
  "title": "Red Sea attacks reroute tanker traffic",
  "summary": "Attacks in the Red Sea are increasing transit risk and forcing rerouting.",
  "actors": ["Houthis"],
  "locations": ["Red Sea", "Suez"],
  "domains": ["commodities", "macro"],
  "sourceIntelIds": ["intel_1", "intel_2"]
}
```

### Thought
```json
{
  "schemaVersion": "1",
  "mechanism": "Shipping friction tightens delivered energy supply and raises transport cost.",
  "causalChain": [
    "shipping disruption rises",
    "rerouting and freight costs increase",
    "effective delivered supply tightens",
    "energy prices and related spreads strengthen"
  ],
  "channels": ["transport", "supply"],
  "firstOrderAssets": ["Brent", "WTI", "Diesel"],
  "secondOrderAssets": ["inflation expectations"],
  "expectedDirectionByAsset": {
    "Brent": "up",
    "WTI": "up",
    "Diesel": "up"
  },
  "timeHorizons": ["1d", "1w"],
  "confidence": 0.63,
  "disconfirmingConditions": [
    "disruption resolves quickly",
    "spare shipping capacity absorbs the shock",
    "broader demand collapse dominates supply risk"
  ]
}
```

### Forecast
```json
{
  "schemaVersion": "1",
  "asset": "Brent",
  "domain": "commodities",
  "expectedDirection": "up",
  "expectedMoveType": "price_up",
  "horizon": "1w",
  "confidence": 0.63,
  "dependsOn": ["persistent disruption"],
  "invalidIf": ["shipping normalizes within 48h"]
}
```

## Event Extraction Design

### Inputs
- recent `intel_items`
- optionally fetched page content
- optional social/data enrichments

### Processing
1. Deterministically group by URL/title similarity and recency.
2. Optionally use LLM consolidation when multiple items appear related but not identical.
3. Generate a stable `event_key` from normalized title + actors + location + date bucket.
4. Upsert into `events`.

### Materiality Gate
Only create thoughts for events that clear a configurable threshold:
- multiple corroborating sources,
- strong language indicating disruption/policy/supply/demand shock,
- relation to tracked domains or assets,
- operator-configured priority themes.

## Thought Generation Design

### Prompting Rules
- Use strict JSON only.
- Ask for mechanism-first reasoning, not narrative-first hype.
- Require explicit uncertainty.
- Require alternative interpretations.
- Require invalidation conditions.

### Validation Rules
- `confidence` clamped to [0,1]
- `firstOrderAssets` non-empty for tradeable thoughts
- `causalChain` minimum length 2 for accepted mechanism thoughts
- `disconfirmingConditions` required
- reject unsupported asset symbols only at adapter level, not at thought level

## Analog Retrieval Design

### MVP Retrieval Strategy
- lexical similarity on event type, actors, locations, and mechanism text
- domain overlap
- asset overlap
- favor cases with resolved outcomes

### Later Improvement Path
- embeddings over event/thought text
- mechanism ontology
- regime-aware similarity scoring

## Market Context Abstraction
Replace direct assumptions that market validation means `perp_market_list` + Hyperliquid signals.

Introduce a market context interface:
- `listUniverse(domain)`
- `resolveAsset(input)`
- `getSnapshot(asset, asOf)`
- `getMove(asset, start, end)`
- `getSupportingSignals(asset, domain, asOf)`

This lets crypto keep current adapters while commodities can add:
- futures/spot references,
- inventory or curve signals,
- domain-specific validation rules.

## Changes to Existing Systems

### `src/core/proactive_search.ts`
Current issue:
- query seeding is driven by watchlist and crypto-oriented context.

Change:
- add domain/theme query seeds,
- support event classes and supply-chain entities,
- allow learned queries to be mechanism-oriented rather than symbol-only.

### `src/core/proactive_refresh.ts`
Current issue:
- fresh context treats `perp_market_list` as mandatory and uses Hyperliquid funding/OI as privileged evidence.

Change:
- make market context domain-aware,
- require at least one valid market confirmation source for the relevant domain rather than crypto-only tools,
- preserve news/web retrieval as generic inputs.

### `src/technical/news.ts`
Current issue:
- keyword sentiment matching is ticker-centric and crypto-specific.

Change:
- de-emphasize naive sentiment as the primary interpretation layer,
- replace with event/thought generation and asset-channel mapping.

### Agent Modes
Current issue:
- trade and mentat modes are optimized around perp tools.

Change:
- preserve crypto tools,
- add generic event-reasoning tools,
- make domain adapters selectable by task and asset family.

## Scheduling
Use the existing scheduled-task infrastructure pattern for deferred resolution checks.

For each forecast:
- schedule validation jobs at configured horizons such as `1h`, `1d`, `1w`, `1m`
- store unresolved status until market data becomes available
- update outcomes idempotently

## Evaluation

### Unit Tests
- event deduplication and stable key generation
- thought schema validation
- analog retrieval ranking
- forecast resolution logic
- mechanism statistics update logic

### Integration Tests
- ingest intel -> event -> thought -> forecast
- forecast -> scheduled resolution -> outcome record
- proactive refresh on non-crypto domains
- crypto domain continues working without regression

### Acceptance Tests
- one active event produces a traceable artifact chain:
  - source intel
  - event
  - thought
  - forecast
  - later outcome

## Rollout Plan

### Phase 1: Event Memory Foundations
- add schema and repository functions
- create event/thought/forecast/outcome types
- wire basic event extraction from existing intel store

### Phase 2: Thought Generation MVP
- add structured LLM prompts and validators
- persist thought versions
- emit monitor-only forecasts

### Phase 3: Forecast Validation Loop
- add scheduler-backed resolution
- implement crypto market adapter first
- record outcomes and mechanism stats

### Phase 4: Domain-Aware Proactive Loop
- refactor proactive refresh and search to use domain-aware market context
- remove crypto-only evidence assumptions from the generic path

### Phase 5: Commodity Readiness
- add commodity asset universe/config scaffolding
- add placeholder market adapter and domain seeds
- prepare for historical event corpus ingestion

## Risks
- LLM thoughts may sound plausible but be mechanically weak unless validation is strict.
- Event clustering may over-merge distinct events or under-merge duplicates.
- Forecast scoring can be misleading if the horizon or asset mapping is underspecified.
- Commodity expansion will stall without reliable market data adapters.
- Historical analog retrieval quality will be limited until enough resolved cases exist.

## Open Questions
- Which market data source should back commodity validation first?
- How should regime tags be defined in MVP: manual taxonomy or inferred labels?
- Should event extraction run continuously in the scheduler or only when proactive search stores enough new intel?
- Should thought generation happen for all events or only those above materiality thresholds?

## Out of Scope for This Doc
- Historical-event corpus design and ingestion workflow
- Fine-tuning strategy
- Automated execution across non-crypto venues

