import { vi, describe, expect, it } from 'vitest';
import { mapExpressionPlan } from '../../src/discovery/expressions.js';
import type { Hypothesis, SignalCluster } from '../../src/discovery/types.js';

vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  listPerpTradeJournals: () => [],
}));

describe('mapExpressionPlan', () => {
  it('maps cluster confidence into expression confidence and positive edge', () => {
    const cluster: SignalCluster = {
      id: 'cluster_1',
      symbol: 'BTC/USDT',
      signals: [],
      directionalBias: 'up',
      confidence: 0.8,
      timeHorizon: 'hours',
    };
    const hypothesis: Hypothesis = {
      id: 'hyp_1',
      clusterId: 'cluster_1',
      pressureSource: 'funding',
      expectedExpression: 'Price drifts up as shorts cover',
      timeHorizon: 'hours',
      invalidation: 'Funding normalizes',
      tradeMap: 'Directional long perp',
      riskNotes: [],
    };
    const config = {
      hyperliquid: { maxLeverage: 5 },
      wallet: { limits: { daily: 100 } },
      autonomy: { probeRiskFraction: 0.005 },
    } as any;

    const expr = mapExpressionPlan(config, cluster, hypothesis);
    expect(expr.confidence).toBeCloseTo(0.8, 6);
    // Adaptive edge: prior=0.015, multiplier=1.3 (strength=0.8, scale=0.5)
    expect(expr.expectedEdge).toBeGreaterThan(0);
  });

  it('reduces edge by 0.4x for momentum_breakout in neutral directional bias (not zeroed)', () => {
    const neutralCluster: SignalCluster = {
      id: 'cluster_1',
      symbol: 'ETH/USDT',
      signals: [],
      directionalBias: 'neutral',
      confidence: 0.9,
      timeHorizon: 'hours',
    };
    const directionalCluster: SignalCluster = {
      ...neutralCluster,
      directionalBias: 'up',
    };
    // _trend suffix → momentum_breakout
    const hypothesis: Hypothesis = {
      id: 'hyp_1_trend',
      clusterId: 'cluster_1',
      pressureSource: 'none',
      expectedExpression: 'No directional edge',
      timeHorizon: 'hours',
      invalidation: 'N/A',
      tradeMap: 'No trade',
      riskNotes: [],
    };
    const config = {
      autonomy: { adaptiveEdge: { enabled: true, priorEdge: 0.015 } },
    } as any;
    const exprNeutral = mapExpressionPlan(config, neutralCluster, hypothesis);
    const exprDirectional = mapExpressionPlan(config, directionalCluster, hypothesis);
    expect(exprNeutral.expectedEdge).toBeGreaterThan(0);
    expect(exprNeutral.expectedEdge).toBeCloseTo(exprDirectional.expectedEdge * 0.4, 5);
  });

  it('does not default discovery leverage to 5x when no cap is configured', () => {
    const cluster: SignalCluster = {
      id: 'cluster_2',
      symbol: 'SOL/USDT',
      signals: [],
      directionalBias: 'up',
      confidence: 0.7,
      timeHorizon: 'hours',
    };
    const hypothesis: Hypothesis = {
      id: 'hyp_2',
      clusterId: 'cluster_2',
      pressureSource: 'flow',
      expectedExpression: 'Price drifts up',
      timeHorizon: 'hours',
      invalidation: 'Flow fades',
      tradeMap: 'Directional long perp',
      riskNotes: [],
    };

    const expr = mapExpressionPlan({} as any, cluster, hypothesis);
    expect(expr.leverage).toBe(1);
  });
});
