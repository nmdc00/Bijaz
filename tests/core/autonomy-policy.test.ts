import { describe, expect, it } from 'vitest';

import {
  classifyMarketRegime,
  computeFractionalKellyFraction,
  evaluateNewsEntryGate,
  isSignalClassAllowedForRegime,
  shouldForceObservationMode,
} from '../../src/core/autonomy_policy.js';

describe('autonomy_policy', () => {
  it('classifies regimes deterministically from price/vol signal metrics', () => {
    const base = {
      id: 'c1',
      symbol: 'BTC/USDT',
      directionalBias: 'up',
      confidence: 0.8,
      timeHorizon: 'hours',
      signals: [
        {
          id: 's1',
          kind: 'price_vol_regime',
          symbol: 'BTC/USDT',
          directionalBias: 'up',
          confidence: 0.9,
          timeHorizon: 'hours',
          metrics: { trend: 0.02, volZ: 0.2 },
        },
      ],
    } as any;

    expect(classifyMarketRegime(base)).toBe('trending');
    expect(
      classifyMarketRegime({
        ...base,
        signals: [{ ...base.signals[0], metrics: { trend: 0.001, volZ: 1.2 } }],
      })
    ).toBe('high_vol_expansion');
    expect(
      classifyMarketRegime({
        ...base,
        signals: [{ ...base.signals[0], metrics: { trend: 0.001, volZ: -0.8 } }],
      })
    ).toBe('low_vol_compression');
  });

  it('enforces regime/signal compatibility matrix', () => {
    expect(isSignalClassAllowedForRegime('momentum_breakout', 'trending')).toBe(true);
    expect(isSignalClassAllowedForRegime('mean_reversion', 'trending')).toBe(false);
    expect(isSignalClassAllowedForRegime('mean_reversion', 'choppy')).toBe(true);
  });

  it('gates news entries by novelty/confirmation/liquidity/volatility/expiry', () => {
    const config = {
      autonomy: {
        newsEntry: {
          minNoveltyScore: 0.6,
          minMarketConfirmationScore: 0.55,
          minLiquidityScore: 0.4,
          minVolatilityScore: 0.25,
          minSourceCount: 1,
        },
      },
    } as any;

    const expr = {
      newsTrigger: {
        enabled: true,
        noveltyScore: 0.7,
        marketConfirmationScore: 0.7,
        liquidityScore: 0.8,
        volatilityScore: 0.9,
        sources: [{ source: 'newsapi', ref: 'intel:1' }],
        expiresAtMs: Date.now() + 60_000,
      },
    } as any;

    expect(evaluateNewsEntryGate(config, expr).allowed).toBe(true);
    expect(
      evaluateNewsEntryGate(config, {
        ...expr,
        newsTrigger: { ...expr.newsTrigger, noveltyScore: 0.2 },
      }).allowed
    ).toBe(false);
    expect(
      evaluateNewsEntryGate(config, {
        ...expr,
        newsTrigger: { ...expr.newsTrigger, sources: [] },
      }).allowed
    ).toBe(false);
    expect(
      evaluateNewsEntryGate(config, {
        ...expr,
        newsTrigger: { ...expr.newsTrigger, expiresAtMs: Date.now() - 1 },
      }).allowed
    ).toBe(false);
  });

  it('computes bounded fractional kelly fraction', () => {
    const low = computeFractionalKellyFraction({
      expectedEdge: 0.01,
      signalExpectancy: 0.1,
      signalVariance: 1,
      sampleCount: 2,
    });
    const high = computeFractionalKellyFraction({
      expectedEdge: 0.2,
      signalExpectancy: 0.9,
      signalVariance: 0.2,
      sampleCount: 40,
      maxFraction: 0.25,
    });

    expect(low).toBeGreaterThanOrEqual(0.01);
    expect(high).toBeLessThanOrEqual(0.25);
    expect(high).toBeGreaterThan(low);
  });

  it('activates observation-mode trigger when thesisCorrect false in 3/5', () => {
    const entries = [
      { thesisCorrect: false },
      { thesisCorrect: false },
      { thesisCorrect: true },
      { thesisCorrect: false },
      { thesisCorrect: true },
    ] as any;

    const result = shouldForceObservationMode(entries, { window: 5, minFalse: 3 });
    expect(result.active).toBe(true);
    expect(result.falseCount).toBe(3);
  });
});
