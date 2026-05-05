import { describe, expect, it } from 'vitest';

import {
  computeExecutionSegmentSummary,
  normalizeJournalEntriesToExecutionLearningCases,
  resolveHierarchicalExecutionEdge,
  type ExecutionLearningSegment,
} from '../../src/core/execution_learning.js';
import type { ThufirConfig } from '../../src/core/config.js';
import type { PerpTradeJournalEntry } from '../../src/memory/perp_trade_journal.js';

const SEGMENT: ExecutionLearningSegment = {
  signalClass: 'mean_reversion',
  marketRegime: 'choppy',
  volatilityBucket: 'medium',
  liquidityBucket: 'normal',
};

function makeConfig(overrides?: Record<string, unknown>): ThufirConfig {
  return {
    autonomy: {
      adaptiveEdge: {
        enabled: true,
        priorEdge: 0.02,
        minSamples: 3,
        signalScaleFactor: 0.5,
        decayHalfLifeDays: null,
        ...overrides,
      },
    },
  } as unknown as ThufirConfig;
}

function makeJournalEntry(
  capturedR: number,
  overrides: Partial<PerpTradeJournalEntry> = {}
): PerpTradeJournalEntry {
  return {
    kind: 'perp_trade_journal',
    symbol: 'BTC',
    outcome: 'executed',
    reduceOnly: true,
    side: 'sell',
    capturedR,
    signalClass: SEGMENT.signalClass,
    marketRegime: SEGMENT.marketRegime as PerpTradeJournalEntry['marketRegime'],
    volatilityBucket: SEGMENT.volatilityBucket as PerpTradeJournalEntry['volatilityBucket'],
    liquidityBucket: SEGMENT.liquidityBucket as PerpTradeJournalEntry['liquidityBucket'],
    snapshot: {
      createdAtMs: 1_700_000_000_000,
      entryPrice: 100,
      exitPrice: 98,
      pricePathHigh: 101,
      pricePathLow: 95,
    },
    ...overrides,
  };
}

describe('execution learning normalization', () => {
  it('normalizes only executed reduce-only journals into execution-quality cases', () => {
    const cases = normalizeJournalEntriesToExecutionLearningCases([
      makeJournalEntry(1.2),
      makeJournalEntry(0.5, { reduceOnly: false }),
      makeJournalEntry(0.5, { outcome: 'blocked' }),
    ]);

    expect(cases).toHaveLength(1);
    expect(cases[0]?.kind).toBe('execution_learning_case');
    expect(cases[0]?.context.signalClass).toBe(SEGMENT.signalClass);
    expect(cases[0]?.quality.capturedR).toBeCloseTo(1.2, 8);
  });
});

describe('computeExecutionSegmentSummary', () => {
  it('computes an exact-match expectancy summary', () => {
    const cases = normalizeJournalEntriesToExecutionLearningCases([
      makeJournalEntry(0.5),
      makeJournalEntry(1.0),
      makeJournalEntry(-0.5),
    ]);

    const summary = computeExecutionSegmentSummary({
      cases,
      segment: SEGMENT,
      sourceLevel: 'exact',
      minSamples: 3,
      decayHalfLifeDays: null,
      nowMs: 1_700_000_000_000,
    });

    expect(summary.sourceLevel).toBe('exact');
    expect(summary.sampleCount).toBe(3);
    expect(summary.expectancy).toBeCloseTo(1 / 3, 8);
    expect(summary.confidenceWeight).toBeGreaterThan(0);
  });
});

describe('resolveHierarchicalExecutionEdge', () => {
  it('backs off from exact to partial to coarse before prior', () => {
    const cases = normalizeJournalEntriesToExecutionLearningCases([
      makeJournalEntry(0.7, { liquidityBucket: 'deep' }),
      makeJournalEntry(0.7, { liquidityBucket: 'deep' }),
      makeJournalEntry(0.7, { liquidityBucket: 'deep' }),
      makeJournalEntry(0.2, { volatilityBucket: 'high', liquidityBucket: 'deep' }),
      makeJournalEntry(0.2, { volatilityBucket: 'high', liquidityBucket: 'deep' }),
      makeJournalEntry(0.2, { volatilityBucket: 'high', liquidityBucket: 'deep' }),
    ]);

    const result = resolveHierarchicalExecutionEdge({
      config: makeConfig(),
      cases,
      segment: SEGMENT,
      signalStrength: 0.5,
      nowMs: 1_700_000_000_000,
    });

    expect(result.sourceLevel).toBe('partial');
    expect(result.empiricalExpectancy).toBeCloseTo(0.7, 8);
  });

  it('uses coarse history when exact and partial are absent', () => {
    const cases = normalizeJournalEntriesToExecutionLearningCases([
      makeJournalEntry(0.35, { volatilityBucket: 'high', liquidityBucket: 'deep' }),
      makeJournalEntry(0.35, { volatilityBucket: 'high', liquidityBucket: 'deep' }),
      makeJournalEntry(0.35, { volatilityBucket: 'high', liquidityBucket: 'deep' }),
    ]);

    const result = resolveHierarchicalExecutionEdge({
      config: makeConfig(),
      cases,
      segment: SEGMENT,
      signalStrength: 0.5,
      nowMs: 1_700_000_000_000,
    });

    expect(result.sourceLevel).toBe('coarse');
    expect(result.empiricalExpectancy).toBeCloseTo(0.35, 8);
  });

  it('falls back to prior when no archetype history exists', () => {
    const cases = normalizeJournalEntriesToExecutionLearningCases([
      makeJournalEntry(1.1, { signalClass: 'momentum_breakout' }),
      makeJournalEntry(1.1, { signalClass: 'momentum_breakout' }),
    ]);

    const result = resolveHierarchicalExecutionEdge({
      config: makeConfig(),
      cases,
      segment: SEGMENT,
      signalStrength: 0.5,
      nowMs: 1_700_000_000_000,
    });

    expect(result.source).toBe('prior');
    expect(result.sourceLevel).toBe('prior');
    expect(result.sampleCount).toBe(0);
  });
});
