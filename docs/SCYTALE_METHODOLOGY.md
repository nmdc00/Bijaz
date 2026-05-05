# Scytale Evaluation Methodology
## Thufir as a falsification test for autonomous structured reasoning

**Branch:** `release-v2.00`  
**Status:** Draft protocol  
**Date:** 2026-05-02  
**Related docs:** [v1.99-prd.md](/tmp/thufir-release-v2.00/docs/v1.99-prd.md), [v1.99-tdd.md](/tmp/thufir-release-v2.00/docs/v1.99-tdd.md), [CAUSAL_EVENT_REASONING_PRD_TDD.md](/tmp/thufir-release-v2.00/docs/CAUSAL_EVENT_REASONING_PRD_TDD.md)

---

## 1. Purpose

This document defines how Thufir is evaluated as an empirical test of the Scytale architecture.

The product claim is **not** "we built a trading bot that makes money." The architecture claim is:

> A structured reasoning substrate can produce probability estimates that outperform a defensible market or baseline comparator in an adversarial, high-noise setting.

Crypto perps and prediction markets are used as the test bed because they provide:

- fast feedback loops
- adversarial conditions
- externally anchored outcomes
- measurable forecasts instead of narrative-only judgments

If the architecture can produce edge here, that is evidence for generalization into weaker-baseline domains such as commodities, compliance, and threat detection.

---

## 2. Research Question

The core question is:

> When Thufir makes a forecast, is its probability estimate closer to the truth than the available baseline at decision time?

This is evaluated per prediction, then aggregated over rolling windows.

The primary statistic is **Brier delta**:

```text
Brier delta = Brier_market - Brier_model
```

Interpretation:

- positive: Thufir beat the comparator
- zero: Thufir matched the comparator
- negative: Thufir underperformed the comparator

This is the headline metric because it is hard to game with narrative framing.

---

## 3. Unit Of Analysis

The unit of analysis is a row in the SQL view `learning_examples`.

That view is the canonical evaluation dataset. A row is included only if all of the following are true:

- `predictions.outcome_basis = 'final'`
- `predictions.model_probability IS NOT NULL`
- `predictions.market_probability IS NOT NULL`
- `predictions.outcome IS NOT NULL`

Implementation reference:

- [src/memory/schema.sql](/tmp/thufir-release-v2.00/src/memory/schema.sql)
- [src/memory/predictions.ts](/tmp/thufir-release-v2.00/src/memory/predictions.ts)
- [src/memory/calibration.ts](/tmp/thufir-release-v2.00/src/memory/calibration.ts)

Anything outside `learning_examples` is **not** part of the headline methodology result.

This means:

- legacy predictions are excluded
- estimated/snapshot-resolved predictions are excluded
- predictions without a defensible baseline comparator are excluded

---

## 4. Prediction Definition

A prediction is a timestamped forecast record containing at minimum:

- a market or asset target
- a predicted binary outcome
- Thufir's probability estimate (`model_probability`)
- a comparator probability (`market_probability`) when available
- an eventual realized outcome

In the current branch, predictions are created from:

- prediction-market execution flows
- some autonomous trade flows

However, only predictions with both clean probabilities and a final outcome are used for Brier-delta evaluation.

The methodology therefore distinguishes between:

### 4.1 Operational predictions

Predictions created to support execution, monitoring, learning, or audit.

### 4.2 Comparable evaluation predictions

Predictions eligible for the headline metric because the row satisfies the `learning_examples` constraints.

This distinction is deliberate. Not every operational forecast should be counted as valid evidence.

---

## 5. Comparator Policy

Comparator quality is the single most important validity issue in this evaluation.

### 5.1 Prediction-market rows

For binary markets, the comparator is the market-implied probability at decision time:

```text
market_probability = market.prices[predicted_outcome]
```

This is currently the cleanest apples-to-apples comparator in the system.

### 5.2 Perp rows

Perps do **not** currently have a production-grade comparator baseline in this methodology.

On `release-v2.00`, the branch intentionally avoids writing fake comparators for new autonomous perp predictions:

- no hardcoded `0.5`
- no claim that a perp directional trade has a valid binary market baseline by default

Implementation reference:

- [src/core/autonomous.ts](/tmp/thufir-release-v2.00/src/core/autonomous.ts)

Therefore:

> **Perp predictions are currently excluded from headline Brier-delta unless and until a real comparator is defined and stored.**

This is not a weakness of the methodology. It is a defense against metric contamination.

### 5.3 What would make perps comparable later?

A future perp comparator must be explicitly chosen and documented before those rows are admitted into the headline metric. Examples:

- funding-implied directional skew
- realized directional frequency over a fixed horizon
- options-implied skew if available
- another documented market-implied baseline at the prediction timestamp

Until then, perp rows remain useful for:

- PnL analysis
- execution quality analysis
- substrate demonstrations
- event → thought → forecast → outcome demonstrations

They do not belong in the main Brier-delta headline.

---

## 6. Outcome Label Policy

Outcome integrity matters as much as comparator integrity.

The methodology uses:

- `outcome_basis = 'final'` for confirmed outcomes
- `outcome_basis = 'estimated'` for snapshot-threshold approximations
- `outcome_basis = 'legacy'` for pre-cleanup rows

Only `'final'` rows count.

Implementation reference:

- [src/core/resolver.ts](/tmp/thufir-release-v2.00/src/core/resolver.ts)
- [src/memory/calibration.ts](/tmp/thufir-release-v2.00/src/memory/calibration.ts)

This prevents training or evaluation on proxy labels that only reflect interim market sentiment.

---

## 7. Metrics

All headline metrics are computed over `learning_examples`.

### 7.1 Accuracy

Binary directional correctness:

```text
predicted = model_probability >= 0.5 ? 1 : 0
accuracy = correct / N
```

Accuracy is reported, but it is secondary.

### 7.2 Brier score

For outcome `y` in `{0,1}`:

```text
Brier_model  = (model_probability  - y)^2
Brier_market = (market_probability - y)^2
```

Lower is better.

### 7.3 Brier delta

```text
Brier delta = average(Brier_market) - average(Brier_model)
```

This is the primary metric.

### 7.4 Rolling windows

The system reports rolling windows of:

- 10
- 20
- 50
- 100
- 200

Implementation reference:

- [src/memory/learning_metrics.ts](/tmp/thufir-release-v2.00/src/memory/learning_metrics.ts)

Current reporting policy:

- if fewer than 20 final comparable predictions exist overall, metrics are scaffolded but null
- a given window is only populated when that full window size is available

This avoids reporting pseudo-precision on trivial samples.

---

## 8. Sample-Size Thresholds

Methodological thresholds in this branch:

- `50` final comparable predictions: minimum threshold for an externally discussable directional read
- `100-150`: stronger investor-grade read
- `200+`: reasonable threshold for deeper calibration fitting and domain-specific inference

These thresholds are pragmatic, not magical. They are chosen to balance:

- early decision usefulness
- statistical humility
- operational speed

The sprint gate for Phase 2 activation was:

```sql
SELECT COUNT(*) FROM learning_examples;
```

Once Phase 2 is live, that same dataset remains the source of truth for the methodology headline.

---

## 9. Pipeline Being Evaluated

The architecture under evaluation is not just a number generator. It is the full reasoning loop:

```text
intel
  → normalized event
  → thought / mechanism
  → forecast
  → execution or record creation
  → outcome resolution
  → rolling evaluation
```

Relevant branch references:

- event extraction: [src/events/extract.ts](/tmp/thufir-release-v2.00/src/events/extract.ts)
- thought generation: [src/events/thoughts.ts](/tmp/thufir-release-v2.00/src/events/thoughts.ts)
- forecast generation and expiry resolution: [src/events/outcomes.ts](/tmp/thufir-release-v2.00/src/events/outcomes.ts)
- runtime orchestration: [src/events/runtime.ts](/tmp/thufir-release-v2.00/src/events/runtime.ts)
- gateway scheduling: [src/gateway/index.ts](/tmp/thufir-release-v2.00/src/gateway/index.ts)

This matters for the YC narrative: the forecast score is the measurement layer on top of a reusable substrate, not an isolated scoring toy.

---

## 10. Dashboard And Reporting Policy

The dashboard is a reporting surface, not the methodology itself.

Phase 2 adds a `predictionAccuracy` section with:

- global rolling windows
- by-domain rolling windows
- total final comparable predictions

Implementation reference:

- [src/gateway/dashboard_api.ts](/tmp/thufir-release-v2.00/src/gateway/dashboard_api.ts)
- [dashboard/src/App.tsx](/tmp/thufir-release-v2.00/dashboard/src/App.tsx)

The dashboard may summarize the methodology, but the methodology is defined by:

- schema
- inclusion rules
- comparator rules
- resolution rules
- formulas in this document

If the UI and this document ever diverge, this document should be treated as authoritative until the code is corrected and the doc updated.

---

## 11. Entry-Gate Use Of The Metric

The architecture is not only measured by the metric; it also adapts to it.

On this branch, the entry gate now contains a deterministic calibration block:

- if a domain has fewer than 20 comparable finals: no calibration action
- if the 20-window Brier delta is materially degrading: resize
- if the 50-window Brier delta is negative: block

Implementation reference:

- [src/core/llm_entry_gate.ts](/tmp/thufir-release-v2.00/src/core/llm_entry_gate.ts)

This does **not** make the methodology circular. The score is still measured on realized outcomes. It simply means the system can use observed calibration to govern future risk.

---

## 12. Threats To Validity

Any externally presented result should be read together with these known risks.

### 12.1 Comparator contamination

If rows are admitted with invented baselines, the headline is invalid.

Mitigation:

- only use `learning_examples`
- exclude perps from headline evaluation until a real baseline exists

### 12.2 Label contamination

Snapshot-threshold outcomes are not final truth.

Mitigation:

- exclude `outcome_basis != 'final'`

### 12.3 Selection effects

The evaluated set may reflect only the predictions the system happened to persist and resolve cleanly.

Mitigation:

- keep write-site logic explicit
- keep exclusions documented
- audit drop reasons over time

### 12.4 Domain mixing

A global aggregate may hide domain-specific failure.

Mitigation:

- always show by-domain windows alongside global windows

### 12.5 Horizon mismatch

Forecast horizons may not line up cleanly across prediction markets, perps, and event forecasts.

Mitigation:

- document horizon source
- avoid mixing incomparable forecast types into one headline number

### 12.6 Operational drift

Prompt changes, gate changes, or resolver changes can alter the experiment midstream.

Mitigation:

- document release branch and commit range for any published result
- log model/version context where possible

---

## 13. Current Branch Position

As of `release-v2.00`:

- PLIL Phase 2 metrics are implemented
- dashboard reporting is implemented
- calibration-aware gate actions are implemented
- fake perp comparator writes were removed from autonomous prediction creation
- the v1.95 event → thought → forecast → outcome runtime loop is wired through the gateway

What this branch **does support**:

- a defensible comparable-prediction methodology
- an architecture narrative tied to real code paths
- a measurable forecasting substrate

What this branch **does not yet support**:

- a defensible perp-inclusive Brier-delta headline

That requires a documented real perp comparator.

---

## 14. External Presentation Rule

Any external statement should use language like:

> "We evaluate only final, comparable predictions with clean model and baseline probabilities. Rows without a defensible comparator are excluded from the headline Brier-delta."

And if discussing perps:

> "Perps are currently part of the operational substrate and PnL experiment, but not part of the main Brier-delta claim until a real comparator baseline is defined."

This is the line that keeps the methodology defensible under scrutiny.

---

## 15. Next Methodology Tasks

1. Define and document whether perps get a real comparator or stay excluded from the headline.
2. Add a lightweight audit report that counts:
   - rows in `predictions`
   - rows in `learning_examples`
   - excluded rows by reason
3. Record model/version metadata per evaluated prediction more explicitly.
4. Add a stable publishable snapshot command for investor/application reporting.

Until those are done, the core rule remains simple:

> Prefer a smaller honest number over a larger contaminated one.
