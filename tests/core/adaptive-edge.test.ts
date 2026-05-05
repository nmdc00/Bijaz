import { describe, it, expect } from 'vitest';
import {
  resolveAdaptiveEdge,
  computeSegmentExpectancy,
} from '../../src/core/adaptive_edge.js';
import type { AdaptiveEdgeSegment } from '../../src/core/adaptive_edge.js';
import type { ThufirConfig } from '../../src/core/config.js';
import type { PerpTradeJournalEntry } from '../../src/memory/perp_trade_journal.js';

const SEG: AdaptiveEdgeSegment = {
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
        priorEdge: 0.015,
        minSamples: 10,
        signalScaleFactor: 0.5,
        decayHalfLifeDays: null,
        ...overrides,
      },
    },
  } as unknown as ThufirConfig;
}

function makeEntry(capturedR: number, seg: Partial<AdaptiveEdgeSegment> = {}): PerpTradeJournalEntry {
  return {
    kind: 'perp_trade_journal',
    symbol: 'BTC',
    outcome: 'executed',
    reduceOnly: true,
    capturedR,
    signalClass: seg.signalClass ?? SEG.signalClass,
    marketRegime: (seg.marketRegime ?? SEG.marketRegime) as PerpTradeJournalEntry['marketRegime'],
    volatilityBucket: (seg.volatilityBucket ?? SEG.volatilityBucket) as PerpTradeJournalEntry['volatilityBucket'],
    liquidityBucket: (seg.liquidityBucket ?? SEG.liquidityBucket) as PerpTradeJournalEntry['liquidityBucket'],
    snapshot: {
      createdAtMs: Date.now(),
      entryPrice: 100,
      exitPrice: 99,
    },
  };
}

describe('computeSegmentExpectancy', () => {
  it('returns null expectancy for empty journal', () => {
    const { expectancy, sampleCount } = computeSegmentExpectancy([], SEG, null);
    expect(expectancy).toBeNull();
    expect(sampleCount).toBe(0);
  });

  it('ignores entries from different segments', () => {
    const journals = [makeEntry(0.5, { signalClass: 'momentum_breakout' })];
    const { expectancy, sampleCount } = computeSegmentExpectancy(journals, SEG, null);
    expect(expectancy).toBeNull();
    expect(sampleCount).toBe(0);
  });

  it('ignores non-executed entries', () => {
    const entry = { ...makeEntry(0.5), outcome: 'blocked' as const };
    const { expectancy } = computeSegmentExpectancy([entry], SEG, null);
    expect(expectancy).toBeNull();
  });

  it('ignores entries with null capturedR', () => {
    const entry = { ...makeEntry(0), capturedR: null };
    const { expectancy } = computeSegmentExpectancy([entry], SEG, null);
    expect(expectancy).toBeNull();
  });

  it('computes simple mean of capturedR', () => {
    const journals = [makeEntry(0.5), makeEntry(1.5), makeEntry(-0.5)];
    const { expectancy, sampleCount } = computeSegmentExpectancy(journals, SEG, null);
    expect(sampleCount).toBe(3);
    expect(expectancy).toBeCloseTo(0.5, 5);
  });

  it('computes negative expectancy for losing segment', () => {
    const journals = [makeEntry(-1.0), makeEntry(-0.5), makeEntry(-1.5)];
    const { expectancy } = computeSegmentExpectancy(journals, SEG, null);
    expect(expectancy).toBeLessThan(0);
  });
});

describe('resolveAdaptiveEdge — prior phase', () => {
  it('returns priorEdge * multiplier when no entries', () => {
    const config = makeConfig();
    const result = resolveAdaptiveEdge(config, [], SEG, 1.0);
    expect(result.source).toBe('prior');
    expect(result.sampleCount).toBe(0);
    expect(result.edge).toBeCloseTo(0.015 * 1.5, 5); // signalStrength=1 → multiplier=1.5
  });

  it('blends lightly toward evidence when entries exist below minSamples', () => {
    const config = makeConfig({ minSamples: 10 });
    const journals = Array.from({ length: 5 }, () => makeEntry(0.8));
    const result = resolveAdaptiveEdge(config, journals, SEG, 0.5);
    expect(result.source).toBe('blended');
    expect(result.sourceLevel).toBe('exact');
    expect(result.sampleCount).toBe(5);
  });

  it('signal strength=0 gives minimum multiplier (1 - scaleFactor)', () => {
    const config = makeConfig({ signalScaleFactor: 0.5 });
    const result = resolveAdaptiveEdge(config, [], SEG, 0);
    // multiplier = 1 - 0.5 + 0 * 0.5 * 2 = 0.5
    expect(result.signalStrengthMultiplier).toBeCloseTo(0.5, 5);
    expect(result.edge).toBeCloseTo(0.015 * 0.5, 5);
  });

  it('signal strength=1 gives maximum multiplier (1 + scaleFactor)', () => {
    const config = makeConfig({ signalScaleFactor: 0.5 });
    const result = resolveAdaptiveEdge(config, [], SEG, 1);
    // multiplier = 1 - 0.5 + 1 * 0.5 * 2 = 1.5
    expect(result.signalStrengthMultiplier).toBeCloseTo(1.5, 5);
    expect(result.edge).toBeCloseTo(0.015 * 1.5, 5);
  });

  it('signal strength=0.5 gives neutral multiplier (1.0)', () => {
    const config = makeConfig({ signalScaleFactor: 0.5 });
    const result = resolveAdaptiveEdge(config, [], SEG, 0.5);
    expect(result.signalStrengthMultiplier).toBeCloseTo(1.0, 5);
    expect(result.edge).toBeCloseTo(0.015, 5);
  });
});

describe('resolveAdaptiveEdge — empirical phase', () => {
  it('transitions to blended after minSamples', () => {
    const config = makeConfig({ minSamples: 5 });
    const journals = Array.from({ length: 5 }, () => makeEntry(0.5));
    const result = resolveAdaptiveEdge(config, journals, SEG, 0.5);
    expect(result.source).toBe('blended');
    expect(result.empiricalExpectancy).toBeCloseTo(0.5, 5);
  });

  it('becomes empirical at 3x minSamples', () => {
    const config = makeConfig({ minSamples: 5 });
    const journals = Array.from({ length: 15 }, () => makeEntry(0.6));
    const result = resolveAdaptiveEdge(config, journals, SEG, 0.5);
    expect(result.source).toBe('empirical');
  });

  it('positive capturedR history produces edge > prior (at 0.5 strength)', () => {
    const config = makeConfig({ minSamples: 5, priorEdge: 0.015 });
    const journals = Array.from({ length: 15 }, () => makeEntry(0.5));
    const result = resolveAdaptiveEdge(config, journals, SEG, 0.5);
    expect(result.edge).toBeGreaterThan(0.015);
  });

  it('negative capturedR history floors edge at 0', () => {
    const config = makeConfig({ minSamples: 5 });
    const journals = Array.from({ length: 15 }, () => makeEntry(-1.0));
    const result = resolveAdaptiveEdge(config, journals, SEG, 1.0);
    expect(result.edge).toBe(0);
  });

  it('uses exact segment matches when they exist', () => {
    const config = makeConfig({ minSamples: 2 });
    const exact = [makeEntry(1.2), makeEntry(0.8)];
    const partial = [
      makeEntry(-3, { liquidityBucket: 'deep' }),
      makeEntry(-3, { liquidityBucket: 'deep' }),
      makeEntry(-3, { liquidityBucket: 'deep' }),
    ];
    const result = resolveAdaptiveEdge(config, [...exact, ...partial], SEG, 0.5);
    expect(result.sourceLevel).toBe('exact');
    expect(result.empiricalExpectancy).toBeCloseTo(1, 5);
    expect(result.sampleCount).toBe(2);
  });

  it('falls back to partial segment when exact history is missing', () => {
    const config = makeConfig({ minSamples: 3 });
    const partialOnly = Array.from({ length: 4 }, () =>
      makeEntry(0.75, { liquidityBucket: 'deep' })
    );
    const result = resolveAdaptiveEdge(config, partialOnly, SEG, 0.5);
    expect(result.sourceLevel).toBe('partial');
    expect(result.sampleCount).toBe(4);
    expect(result.empiricalExpectancy).toBeCloseTo(0.75, 5);
  });

  it('falls back to coarse segment when exact and partial history are missing', () => {
    const config = makeConfig({ minSamples: 3 });
    const coarseOnly = Array.from({ length: 4 }, () =>
      makeEntry(0.4, { volatilityBucket: 'high', liquidityBucket: 'deep' })
    );
    const result = resolveAdaptiveEdge(config, coarseOnly, SEG, 0.5);
    expect(result.sourceLevel).toBe('coarse');
    expect(result.sampleCount).toBe(4);
    expect(result.empiricalExpectancy).toBeCloseTo(0.4, 5);
  });

  it('falls back to archetype-level history before prior', () => {
    const config = makeConfig({ minSamples: 3 });
    const archetypeOnly = Array.from({ length: 4 }, () =>
      makeEntry(0.25, {
        marketRegime: 'trending',
        volatilityBucket: 'high',
        liquidityBucket: 'deep',
      })
    );
    const result = resolveAdaptiveEdge(config, archetypeOnly, SEG, 0.5);
    expect(result.sourceLevel).toBe('archetype');
    expect(result.sampleCount).toBe(4);
    expect(result.empiricalExpectancy).toBeCloseTo(0.25, 5);
  });

  it('returns prior when no archetype history exists', () => {
    const config = makeConfig({ minSamples: 3 });
    const noSignalMatch = Array.from({ length: 4 }, () =>
      makeEntry(2.0, { signalClass: 'momentum_breakout' })
    );
    const result = resolveAdaptiveEdge(config, noSignalMatch, SEG, 0.5);
    expect(result.source).toBe('prior');
    expect(result.sourceLevel).toBe('prior');
    expect(result.sampleCount).toBe(0);
  });
});

describe('resolveAdaptiveEdge — disabled path', () => {
  it('returns edge=0 and source=prior when disabled', () => {
    const config = makeConfig({ enabled: false });
    const journals = Array.from({ length: 20 }, () => makeEntry(1.0));
    const result = resolveAdaptiveEdge(config, journals, SEG, 1.0);
    expect(result.edge).toBe(0);
    expect(result.source).toBe('prior');
  });
});
