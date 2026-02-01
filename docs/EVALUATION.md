# Evaluation & Iteration Dashboard
Last updated: 2026-02-01

## Purpose

Provide a live-mode evaluation loop that is **LLM-free** (SQLite only) and
gives Thufir + the operator objective feedback to iterate on:

- predictive accuracy and calibration
- trading P&L and edge
- process quality (critic approvals, fragility signals, tool usage)

---

## Data Sources

Primary:
- `predictions` (predicted probability, outcome, Brier contribution)
- `trades` (cash flow, execution price, realized P&L)
- `market_cache` (domain/category)

Process audit:
- `decision_audit` (critic approvals, fragility, tool/plan traces)

---

## Metrics (Minimal Dashboard)

Totals:
- predictions / executed / resolved
- accuracy, average Brier
- average edge: `predicted_probability - execution_price`
- realized + unrealized + total P&L

By domain:
- same metrics per domain, sorted by total P&L

Process metrics (if `decision_audit` exists):
- decisions logged
- critic approvals / rejections
- average fragility score
- tool trace coverage

---

## CLI

```bash
thufir eval
thufir eval --window 30
thufir eval --domain crypto
thufir eval --json
```

---

## Agent Access

Tool:
- `evaluation.summary` (agent tool)
- `evaluation_summary` (core tool)

Inputs:
- `window_days` (optional)
- `domain` (optional)

---

## Decision Audit (Schema)

`decision_audit` stores:
- trade metadata (market, amount, outcome)
- critic approval + issues
- fragility score
- tool/plan traces (JSON)
- summary notes

This is **internal-only** and does not change LLM usage unless explicitly queried.
