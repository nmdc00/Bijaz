# Historical Event Training: PRD + TDD

Last updated: 2026-03-12

## Context
Thufir needs a historical casebase that teaches event -> mechanism -> consequence reasoning. The unit of training should be a structured case, not a loose pile of articles.

This doc defines the historical-event training design and logs an initial validated seed set of seven cases. These cases are intended for retrieval-first learning, evaluation, and later fine-tuning if the corpus quality is high enough.

---

# PRD

## Goal
Build a structured historical casebase that helps Thufir:
- recognize recurring event patterns,
- infer causal mechanisms,
- map them to tradable assets,
- estimate direction and timing,
- and learn from realized outcomes.

## Non-goals
- Full fine-tuning in the MVP.
- Fully automated backfill of decades of events in this first pass.
- Perfect coverage of all commodity and macro events before launch.

## Training Unit
Each historical case must include:
- `event`
- `context`
- `thought`
- `forecast`
- `outcome`

This gives the model both the event facts and the reasoning path, not just the label.

## Product Requirements

### R1: Cases Must Be Structured
Every case must include:
- event date
- event type
- geography
- actors
- domain
- affected supply/demand channels
- first-order and second-order assets
- causal mechanism
- causal chain
- expected direction
- forecast horizons
- realized outcomes
- notes on confounders / priced-in effects

### R2: Cases Must Be Retrieval-Friendly
The stored representation must support retrieval by:
- event type
- region
- asset
- mechanism keywords
- regime tags
- whether the case worked or failed

### R3: Cases Must Distinguish Event Facts from Interpretation
We need to preserve:
- what happened,
- what Thufir would have thought at the time,
- and what actually happened later.

This is required to avoid hindsight contamination in future training/evaluation.

### R4: Cases Must Be Outcome-Scored
Each case must log:
- direction correctness
- timing correctness
- magnitude quality
- persistence/reversal quality
- whether the move was quickly retraced
- whether another force dominated

### R5: MVP Corpus Must Be Small but High-Quality
The first corpus should prioritize canonical, explainable events over breadth.

Target:
- 200-500 curated cases in the first strong corpus
- start with a smaller manually validated seed set

---

# TDD

## Data Model

### `historical_event_cases`
- `id`
- `case_key`
- `event_date`
- `event_type`
- `title`
- `summary`
- `domain`
- `actors_json`
- `locations_json`
- `channels_json`
- `first_order_assets_json`
- `second_order_assets_json`
- `mechanism`
- `causal_chain_json`
- `forecast_horizons_json`
- `regime_tags_json`
- `validation_status`
- `created_at`
- `updated_at`

### `historical_case_outcomes`
- `id`
- `case_id`
- `asset`
- `horizon`
- `expected_direction`
- `realized_direction`
- `direction_correct`
- `magnitude_note`
- `timing_note`
- `priced_in_note`
- `chart_note`
- `created_at`

### `historical_case_sources`
- `id`
- `case_id`
- `source_type` (`event|price_chart|secondary_context`)
- `title`
- `url`
- `publisher`
- `source_date`
- `notes`

## Labeling Rules

### Event Fact Rules
- Event fields must reflect information knowable at the time.
- Avoid outcome leakage in event summaries.

### Thought Rules
- Mechanism must be explicit.
- Causal chain should have at least two steps.
- Asset mapping should separate first-order from second-order impacts.

### Outcome Rules
- Outcome notes may use hindsight, but they must be clearly separated from the event/thought fields.
- If the move happened but was immediately retraced, note that.
- If the event thesis was right but timing was poor, mark timing separately from direction.

## Retrieval Strategy

### MVP
- exact and fuzzy matching on:
  - `event_type`
  - `locations`
  - `channels`
  - `first_order_assets`
  - `mechanism`
  - `regime_tags`

### Later
- embeddings over event/thought text
- mechanism ontology
- regime-conditioned scoring

## Ingestion Workflow
1. Curate event candidates manually.
2. Verify the event from at least one high-quality source.
3. Confirm price behavior from a chart/data source.
4. Write a structured case.
5. Mark `validation_status`:
   - `validated`
   - `provisional`
   - `needs_review`

## Seed Cases: Validated Initial Seven

These are the first seven logged cases. They are suitable as seed retrieval examples, not yet a complete training corpus.

### Case 1: Russia Grain Export Ban -> Wheat Spike
- `case_key`: `2010-russia-grain-export-ban-wheat`
- `event_date`: `2010-08-05`
- `event_type`: `export_ban`
- `domain`: `commodities`
- `locations`: `["Russia", "Black Sea"]`
- `channels`: `["supply", "export_flows"]`
- `first_order_assets`: `["wheat"]`
- `second_order_assets`: `["global food inflation"]`
- `mechanism`: Russian drought and wildfire damage triggered an export ban, reducing expected global exportable wheat supply.
- `causal_chain`:
  - drought and fires damage Russian grain output
  - Russia bans grain exports
  - global wheat importers must source elsewhere
  - wheat prices reprice higher on tighter export supply
- `forecast_note`: bullish wheat over short/medium horizon
- `outcome_note`: validated directional spike in wheat during August 2010
- `chart_confirmation`: MacroTrends wheat chart shows 2010 annual high at `6.9425` and a sharp late-summer rise.
- `sources`:
  - Event: DW, "Russian export ban", 2010-08-06  
    https://www.dw.com/en/wheat-prices-soar-as-russia-bans-grain-exports/a-5870888
  - Event: Al Jazeera, "Russia bans exports of grain", 2010-08-05  
    https://www.aljazeera.com/news/2010/8/5/russia-bans-exports-of-grain
  - Price chart: MacroTrends wheat historical chart  
    https://app.macrotrends.net/2534/wheat-prices-historical-chart-data

### Case 2: U.S. Drought -> Corn Spike
- `case_key`: `2012-us-drought-corn`
- `event_date`: `2012-07-11`
- `event_type`: `weather_shock`
- `domain`: `commodities`
- `locations`: `["United States", "Corn Belt"]`
- `channels`: `["supply", "crop_yields"]`
- `first_order_assets`: `["corn"]`
- `second_order_assets`: `["soybeans", "wheat", "food inflation", "livestock margins"]`
- `mechanism`: Extreme heat and drought sharply reduced expected corn yields and inventories.
- `causal_chain`:
  - drought and extreme heat hit the Corn Belt
  - USDA cuts expected corn crop materially
  - expected ending stocks tighten
  - corn prices surge and food/feed concerns spread
- `forecast_note`: bullish corn over days/weeks while drought persists
- `outcome_note`: validated; corn rallied to 2012 highs near `8.3125` per bushel
- `chart_confirmation`: MacroTrends corn chart shows 2012 high at `8.3125`; USDA documented the 12% crop cut and drought exposure.
- `sources`:
  - Event: USDA, "Agricultural Weather and Drought Update – 7/12/12"  
    https://www.usda.gov/about-usda/news/blog/agricultural-weather-and-drought-update-71212
  - Event: USDA, "Agricultural Weather and Drought Update - 7/20/12"  
    https://www.usda.gov/about-usda/news/blog/agricultural-weather-and-drought-update-72012
  - Price chart: MacroTrends corn historical chart  
    https://app.macrotrends.net/2532/corn-prices-historical-chart-data

### Case 3: Abqaiq/Khurais Attack -> Oil Spike
- `case_key`: `2019-abqaiq-attack-oil`
- `event_date`: `2019-09-14`
- `event_type`: `infrastructure_attack`
- `domain`: `commodities`
- `locations`: `["Saudi Arabia", "Abqaiq", "Khurais"]`
- `channels`: `["supply", "infrastructure", "geopolitical_risk"]`
- `first_order_assets`: `["Brent", "WTI"]`
- `second_order_assets`: `["gasoline", "inflation expectations"]`
- `mechanism`: A major attack on Saudi processing/output infrastructure temporarily removed a large share of global oil supply.
- `causal_chain`:
  - attacks disable major Saudi oil facilities
  - market prices near-term supply loss and geopolitical escalation
  - crude risk premium rises sharply
  - oil benchmarks gap higher
- `forecast_note`: bullish oil immediately after event
- `outcome_note`: validated initial spike; later partially retraced as restoration timeline improved
- `chart_confirmation`: CNBC reported Brent up as much as `19.5%` intraday to `71.95`; MacroTrends Brent chart shows 2019 high at `74.94`.
- `sources`:
  - Event + price: CNBC, "An oil price risk premium is back after attacks in Saudi Arabia wipe out 5% of global supply", 2019-09-16  
    https://www.cnbc.com/2019/09/16/oil-prices-saudi-drone-strikes-wipe-out-5percent-of-global-supply.html
  - Follow-up: CNBC, "Oil drops 5% one day after historic surge as Saudis signal output to return to normal soon", 2019-09-17  
    https://www.cnbc.com/2019/09/17/oil-slips-following-the-biggest-climb-in-history-after-saudi-attacks.html
  - Price chart: MacroTrends Brent crude daily chart  
    https://app.macrotrends.net/2480/brent-crude-oil-prices-10-year-daily-chart

### Case 4: COVID Demand Collapse -> Negative WTI
- `case_key`: `2020-covid-demand-collapse-negative-wti`
- `event_date`: `2020-04-20`
- `event_type`: `demand_shock`
- `domain`: `commodities`
- `locations`: `["Global", "United States", "Cushing"]`
- `channels`: `["demand", "storage", "futures_expiry"]`
- `first_order_assets`: `["WTI"]`
- `second_order_assets`: `["energy equities", "credit stress"]`
- `mechanism`: Pandemic lockdowns crushed oil demand, storage filled, and expiring long holders without delivery capacity were forced out.
- `causal_chain`:
  - COVID lockdowns collapse transport demand
  - crude inventories and storage stress surge
  - front-month expiry approaches with weak physical demand
  - May WTI contract collapses into negative pricing
- `forecast_note`: bearish prompt WTI / front-month dislocation under extreme storage stress
- `outcome_note`: validated; May WTI settled at `-37.63` on 2020-04-20
- `chart_confirmation`: CFTC documented the one-day collapse from about `18` to `-37`; MacroTrends WTI chart shows 2020 low at `11.26` on the broader series and confirms the crash year.
- `sources`:
  - Event + price: CFTC Commissioner statement, 2020-05-07  
    https://www.cftc.gov/PressRoom/SpeechesTestimony/berkovitzstatement050720
  - Event + price: CFTC interim report press release, 2020-11-23  
    https://www.cftc.gov/PressRoom/PressReleases/8315-20
  - Price chart: MacroTrends crude oil historical chart  
    https://app.macrotrends.net/1369/crude-oil-price-history-chart

### Case 5: Brazil Frost -> Coffee Spike
- `case_key`: `2021-brazil-frost-coffee`
- `event_date`: `2021-07-20`
- `event_type`: `weather_shock`
- `domain`: `commodities`
- `locations`: `["Brazil"]`
- `channels`: `["supply", "crop_damage"]`
- `first_order_assets`: `["arabica coffee"]`
- `second_order_assets`: `["retail coffee prices"]`
- `mechanism`: Severe frost hit Brazil's coffee belt, damaging supply expectations for the world's largest producer.
- `causal_chain`:
  - frost hits Brazilian coffee regions
  - expected arabica output falls
  - traders reprice future availability
  - coffee futures surge
- `forecast_note`: bullish coffee over short/medium horizon
- `outcome_note`: validated; ICO-referenced reporting says daily arabica prices rose `25.4%` in one week from `165.64` to `207.8` US cents/lb
- `chart_confirmation`: MacroTrends coffee chart shows 2021 high at `2.4985` $/lb and strong 2021 uptrend.
- `sources`:
  - Event + price summary referencing ICO report: Global Coffee Report, 2021-08-12  
    https://www.gcrmag.com/coffee-prices-reach-seven-year-high-due-to-concerns-over-frost-in-brazil/
  - Price details echoing ICO monthly report: StoneX, 2021-08  
    https://www.stonex.com/en/market-intelligence/prices-for-arabica-coffee-in-july-2021-surged-to-highest-levels-since-november-2014/
  - Price chart: MacroTrends coffee historical chart  
    https://app.macrotrends.net/2535/coffee-prices-historical-chart-data

### Case 6: Ukraine Invasion -> Wheat and Food Shock
- `case_key`: `2022-ukraine-invasion-wheat`
- `event_date`: `2022-02-24`
- `event_type`: `war_supply_shock`
- `domain`: `commodities`
- `locations`: `["Ukraine", "Black Sea"]`
- `channels`: `["supply", "export_flows", "shipping", "war_risk"]`
- `first_order_assets`: `["wheat", "maize"]`
- `second_order_assets`: `["vegetable oils", "global food inflation"]`
- `mechanism`: Russia's invasion disrupted Black Sea exports from a major grain-producing region and raised global food security concerns.
- `causal_chain`:
  - invasion disrupts Ukrainian exports and shipping
  - importers fear reduced grain availability
  - cereal prices reprice sharply higher
  - global food inflation accelerates
- `forecast_note`: bullish wheat and related grains in the immediate aftermath
- `outcome_note`: validated; FAO said world food prices hit record highs in March 2022 and wheat prices were strongly affected
- `chart_confirmation`: MacroTrends wheat chart shows 2022 high at `12.94`; FAO stated March 2022 was the peak shock window.
- `sources`:
  - Event + official context: FAO, "War largely drives food prices to record levels, threatens global food security", 2022-04-08  
    https://www.fao.org/new-york/news/news-detail/War-largely-drives-food-prices-to-record-levels-threatens-global-food-security/en
  - Follow-up: FAO, "FAO Food Price Index eases in April", 2022-05-06  
    https://www.fao.org/newsroom/detail/fao-food-price-index-eases-in-april/en
  - Price chart: MacroTrends wheat historical chart  
    https://app.macrotrends.net/2534/wheat-prices-historical-chart-data

### Case 7: Freeport LNG Outage -> Henry Hub Selloff
- `case_key`: `2022-freeport-lng-outage-henry-hub`
- `event_date`: `2022-06-08`
- `event_type`: `infrastructure_outage`
- `domain`: `commodities`
- `locations`: `["United States", "Freeport LNG"]`
- `channels`: `["demand", "export_capacity"]`
- `first_order_assets`: `["Henry Hub natural gas"]`
- `second_order_assets`: `["U.S. gas balances", "LNG export expectations"]`
- `mechanism`: The Freeport outage reduced U.S. LNG export demand, leaving more gas in the domestic market and pushing Henry Hub lower.
- `causal_chain`:
  - Freeport LNG shuts down
  - U.S. gas export capacity drops
  - more gas remains in domestic balance
  - Henry Hub reprices lower
- `forecast_note`: bearish Henry Hub while outage persists
- `outcome_note`: validated; EIA said Henry Hub fell by `$1.27/MMBtu` to `$8.16` on June 9 and ended June at `$6.54`
- `chart_confirmation`: MacroTrends natural-gas chart shows 2022 was highly volatile with a major summer decline after the early-year run-up.
- `sources`:
  - Event + official context: EIA press release, 2022-07-12  
    https://www.eia.gov/pressroom/releases/press512.php
  - Event + official price figures citing EIA: LNG Industry, 2022-07-25  
    https://www.lngindustry.com/liquid-natural-gas/25072022/eia-freeport-lng-outage-shifts-us-supply-and-demand-balance/
  - Price chart: MacroTrends natural gas historical chart  
    https://app.macrotrends.net/2478/natural-gas-prices-historical-chart

## Notes on Validation Quality
- Cases 2, 4, 6, and 7 have direct official-agency support in the cited sources.
- Cases 1, 3, and 5 are validated with strong contemporaneous reporting plus chart confirmation; they can be upgraded later with additional primary-source event documents if desired.
- The price chart references are used as visual confirmation, not as the sole evidentiary basis.

## Next Expansion Priorities
1. Add 20-30 more canonical commodity cases:
- OPEC cuts/increases
- sanctions
- export bans
- drought/flood/weather shocks
- refinery outages
- shipping chokepoint disruptions

2. Add 20-30 macro cases:
- CPI surprises
- FOMC shocks
- payrolls
- central-bank pivots
- sovereign crises

3. Add 20-30 crypto analog cases:
- ETF approvals/denials
- exchange failures
- regulatory actions
- stablecoin breaks
- halving/liquidity regime shifts

