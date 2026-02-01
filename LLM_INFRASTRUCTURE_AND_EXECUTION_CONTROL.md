# LLM_INFRASTRUCTURE_AND_EXECUTION_CONTROL.md
Last updated: 2026-02-01

## Purpose

This document defines how Thufir Hawat treats **LLMs as shared infrastructure**, not as an unlimited reasoning surface.

Goals:
- Eliminate rate-limit cascades
- Reduce paid LLM usage by 60–90%
- Make execution deterministic under load
- Offload trivial tasks to free local models
- Ensure graceful degradation instead of retries/fallback spirals

This document is authoritative for:
- execution budgeting
- provider cooldowns
- tiered execution modes
- local LLM usage (“trivial tasks”)
- backpressure behavior

---

## Core Principles

1. **Most cycles should not call an LLM**
2. **LLM calls are budgeted, not assumed**
3. **Retries are a failure mode, not a strategy**
4. **Local models handle plumbing; remote models handle judgment**
5. **System must fail quiet, not loud**

---

## Execution Modes (Hard Requirement)

All autonomous, scan, and agent paths MUST select an execution mode *before* any LLM call.

### ExecutionMode

- `MONITOR_ONLY`
  - No LLM calls
  - Deterministic checks only
  - Default when nothing materially changed

- `LIGHT_REASONING`
  - Max 1 LLM call
  - No critic
  - Small prompt, batched inputs

- `FULL_AGENT`
  - Full orchestrator loop
  - Tools + reflection + critic
  - Used only when stakes justify cost

Target distribution:
- 80–90% MONITOR_ONLY
- 5–15% LIGHT_REASONING
- <5% FULL_AGENT

---

## Global LLM Budget

### Budget Scope
Budgets are global, not per-feature.

Tracked per rolling hour:
- calls
- estimated tokens

### Required Controls
- `maxCallsPerHour`
- `maxTokensPerHour`
- reserved budget for **critical** operations (live trades, pre-trade analysis)
- persistent storage (SQLite or disk JSON)

### Budget Behavior
- If budget exceeded:
  - Non-critical tasks degrade to MONITOR_ONLY
  - No retries
  - No silent fallback
- Budget checks happen **before** provider calls

---

## Provider Cooldowns (Backpressure)

On any 429 / rate-limit error:
- Provider enters cooldown
- Cooldown duration increases exponentially (bounded)
- During cooldown:
  - No retries
  - No fallback unless critical + reserve budget exists

Cooldown is provider+model specific.

---

## Call Collapsing Rules

To reduce call count:

- Planner + executor merged for LIGHT_REASONING
- Critic only runs when:
  - trade size > threshold OR
  - fragility > threshold OR
  - confidence is high
- No explanations unless requested or required for audit

---

## Caching (Mandatory)

### Cache What’s Expensive to Think About
- market understanding summaries
- domain playbooks
- fragility cards
- mentat outputs

### Cache What’s Expensive to Fetch
- market metadata
- comments
- intel search results

Use TTL + invalidation on material deltas.

---

## Local LLM: Trivial Task Offload (Part C)

### Definition: Trivial Tasks

Local LLM MAY be used for:
- summarizing intel batches
- compressing tool outputs
- entity / keyword extraction
- JSON normalization
- tool routing hints
- formatting and titles

Local LLM MUST NOT be used for:
- trade decisions
- probability estimates used for execution
- multi-step agent loops
- mentat synthesis

---

## Local LLM Provider

### Runtime Assumption
- OpenAI-compatible local endpoint
- Default: `http://localhost:11434/v1/chat/completions` (Ollama)

### Recommended Models (4GB RAM)
- `qwen2.5:1.5b-instruct` (primary)
- `llama3.2:1b-instruct` (fallback)

---

## Configuration

```yaml
agent:
  trivialTaskProvider: local
  trivialTaskModel: qwen2.5:1.5b-instruct
  localBaseUrl: http://localhost:11434

  trivial:
    enabled: true
    maxTokens: 256
    temperature: 0.2
    timeoutMs: 30000
