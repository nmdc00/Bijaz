import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapExpressionPlan } from '../../src/discovery/expressions.js';
import type { ThufirConfig } from '../../src/core/config.js';
import type { Hypothesis, SignalCluster } from '../../src/discovery/types.js';

// Mock journal so tests don't hit SQLite
vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  listPerpTradeJournals: () => [],
}));

function makeConfig(adaptiveEdge?: Record<string, unknown>): ThufirConfig {
  return {
    hyperliquid: { maxLeverage: 5 },
    wallet: { limits: { daily: 100 } },
    autonomy: {
      probeRiskFraction: 0.005,
      adaptiveEdge: {
        enabled: true,
        priorEdge: 0.015,
        minSamples: 10,
        signalScaleFactor: 0.5,
        decayHalfLifeDays: null,
        ...adaptiveEdge,
      },
    },
  } as unknown as ThufirConfig;
}

function makeCluster(
  symbol: string,
  directionalBias: 'up' | 'down' | 'neutral',
  confidence: number,
  volZ = 0,
  hasReflex = false
): SignalCluster {
  const signals: SignalCluster['signals'] = [
    {
      kind: 'price_vol_regime',
      confidence,
      metrics: { trend: directionalBias === 'neutral' ? 0 : 0.02, volZ },
      directionalBias,
    },
    {
      kind: 'orderflow_imbalance',
      confidence,
      metrics: { imbalance: 0.2, tradeCount: 10 },
      directionalBias,
    },
  ];

  if (hasReflex) {
    signals.push({
      kind: 'reflexivity_fragility',
      confidence,
      metrics: { setupScore: 0.7, fundingRate: 0.0001 },
      directionalBias,
    });
  }

  return {
    id: `cluster_${symbol}`,
    symbol,
    confidence,
    directionalBias,
    timeHorizon: '4h',
    signals,
  };
}

function makeHypothesis(symbol: string, suffix: '_trend' | '_revert' | '_reflex'): Hypothesis {
  const baseId = `${symbol}_123`;
  const id = `hyp_${baseId}${suffix}`;
  return {
    id,
    clusterId: `cluster_${symbol}`,
    pressureSource: 'test',
    expectedExpression: suffix === '_revert' ? 'reversion down' : 'upside continuation',
    timeHorizon: '4h',
    invalidation: 'price fails',
    tradeMap: 'directional perp',
    riskNotes: [],
  };
}

describe('_reflex signal class bug fix', () => {
  it('_reflex hypothesis has signalClass liquidation_cascade (not news_event)', () => {
    const config = makeConfig();
    const cluster = makeCluster('BTC', 'up', 0.7, 1.5, true);
    const hypothesis = makeHypothesis('BTC', '_reflex');
    const expr = mapExpressionPlan(config, cluster, hypothesis);
    expect(expr.signalClass).toBe('liquidation_cascade');
  });

  it('_reflex expression has no newsTrigger', () => {
    const config = makeConfig();
    const cluster = makeCluster('BTC', 'up', 0.7, 1.5, true);
    const hypothesis = makeHypothesis('BTC', '_reflex');
    const expr = mapExpressionPlan(config, cluster, hypothesis);
    expect(expr.newsTrigger).toBeNull();
  });

  it('_revert hypothesis has signalClass mean_reversion', () => {
    const config = makeConfig();
    const cluster = makeCluster('ETH', 'down', 0.6);
    const hypothesis = makeHypothesis('ETH', '_revert');
    const expr = mapExpressionPlan(config, cluster, hypothesis);
    expect(expr.signalClass).toBe('mean_reversion');
  });

  it('_trend hypothesis has signalClass momentum_breakout', () => {
    const config = makeConfig();
    const cluster = makeCluster('SOL', 'up', 0.65);
    const hypothesis = makeHypothesis('SOL', '_trend');
    const expr = mapExpressionPlan(config, cluster, hypothesis);
    expect(expr.signalClass).toBe('momentum_breakout');
  });
});

describe('neutral bias handling', () => {
  it('momentum_breakout in neutral bias → expectedEdge reduced by 0.4x (not zeroed)', () => {
    const config = makeConfig();
    const cluster = makeCluster('BTC', 'neutral', 0.8);
    const hypothesis = makeHypothesis('BTC', '_trend');
    const exprNeutral = mapExpressionPlan(config, cluster, hypothesis);
    const clusterDirectional = makeCluster('BTC', 'up', 0.8);
    const exprDirectional = mapExpressionPlan(config, clusterDirectional, hypothesis);
    // Neutral should be > 0 but reduced vs. directional
    expect(exprNeutral.expectedEdge).toBeGreaterThan(0);
    expect(exprNeutral.expectedEdge).toBeCloseTo(exprDirectional.expectedEdge * 0.4, 5);
  });

  it('mean_reversion in neutral bias → expectedEdge > 0 (adaptive prior)', () => {
    const config = makeConfig({ priorEdge: 0.015 });
    const cluster = makeCluster('BTC', 'neutral', 0.8);
    const hypothesis = makeHypothesis('BTC', '_revert');
    const expr = mapExpressionPlan(config, cluster, hypothesis);
    expect(expr.expectedEdge).toBeGreaterThan(0);
  });

  it('liquidation_cascade in neutral bias → expectedEdge > 0 (adaptive prior)', () => {
    const config = makeConfig({ priorEdge: 0.015 });
    const cluster = makeCluster('BTC', 'neutral', 0.8, 1.5, true);
    const hypothesis = makeHypothesis('BTC', '_reflex');
    const expr = mapExpressionPlan(config, cluster, hypothesis);
    expect(expr.expectedEdge).toBeGreaterThan(0);
  });
});

describe('legacy path (adaptiveEdge.enabled: false)', () => {
  it('uses confidence * 0.1 for non-neutral bias', () => {
    const config = makeConfig({ enabled: false });
    const cluster = makeCluster('BTC', 'up', 0.6);
    const hypothesis = makeHypothesis('BTC', '_trend');
    const expr = mapExpressionPlan(config, cluster, hypothesis);
    expect(expr.expectedEdge).toBeCloseTo(0.6 * 0.1, 5);
  });

  it('returns 0 for neutral bias in legacy mode', () => {
    const config = makeConfig({ enabled: false });
    const cluster = makeCluster('BTC', 'neutral', 0.8);
    const hypothesis = makeHypothesis('BTC', '_revert');
    const expr = mapExpressionPlan(config, cluster, hypothesis);
    expect(expr.expectedEdge).toBe(0);
  });
});

describe('carry penalty for liquidation_cascade', () => {
  it('applies carry penalty when paying funding', () => {
    const config = makeConfig({ priorEdge: 0.1, minSamples: 0 });
    // buying into a positive funding rate (paying side)
    const cluster: SignalCluster = {
      id: 'c1',
      symbol: 'BTC',
      confidence: 0.7,
      directionalBias: 'up',
      timeHorizon: '4h',
      signals: [
        { kind: 'price_vol_regime', confidence: 0.7, metrics: { trend: 0.02, volZ: 1.5 }, directionalBias: 'up' },
        { kind: 'orderflow_imbalance', confidence: 0.7, metrics: { imbalance: 0.3, tradeCount: 12 }, directionalBias: 'up' },
        {
          kind: 'reflexivity_fragility',
          confidence: 0.7,
          metrics: { setupScore: 0.8, fundingRate: 0.01 }, // large positive funding
          directionalBias: 'up',
        },
      ],
    };
    const hypothesis = makeHypothesis('BTC', '_reflex');
    const expr = mapExpressionPlan(config, cluster, hypothesis);
    // Edge should be reduced by carry penalty
    const rawEdge = resolveAdaptiveEdgeEdge(config, 0.7);
    expect(expr.expectedEdge).toBeLessThan(rawEdge);
  });
});

// Helper to get raw edge without carry penalty for comparison
function resolveAdaptiveEdgeEdge(config: ThufirConfig, confidence: number): number {
  // With priorEdge=0.1, minSamples=0 (so immediately empirical but no data), strength=0.7
  // multiplier = 1 - 0.5 + 0.7 * 0.5 * 2 = 1.2
  const prior = (config.autonomy as any)?.adaptiveEdge?.priorEdge ?? 0.015;
  const scale = (config.autonomy as any)?.adaptiveEdge?.signalScaleFactor ?? 0.5;
  const multiplier = 1 - scale + confidence * scale * 2;
  return prior * multiplier;
}
