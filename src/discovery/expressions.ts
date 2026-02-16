import type { ThufirConfig } from '../core/config.js';
import type { ExpressionPlan, Hypothesis, SignalCluster } from './types.js';

export function mapExpressionPlan(
  config: ThufirConfig,
  cluster: SignalCluster,
  hypothesis: Hypothesis
): ExpressionPlan {
  const leverage = Math.min(config.hyperliquid?.maxLeverage ?? 5, 5);
  const dailyLimit = config.wallet?.limits?.daily ?? 100;
  const probeFraction = config.autonomy?.probeRiskFraction ?? 0.005;
  const probeBudget = Math.max(1, dailyLimit * probeFraction);
  const side = hypothesis.expectedExpression.includes('down') ? 'sell' : 'buy';
  const confidence = Math.min(1, Math.max(0, cluster.confidence));
  const reflex = cluster.signals.find((s) => s.kind === 'reflexivity_fragility');
  const priceVol = cluster.signals.find((s) => s.kind === 'price_vol_regime');
  const orderflow = cluster.signals.find((s) => s.kind === 'orderflow_imbalance');

  let expectedEdge =
    cluster.directionalBias === 'neutral' ? 0 : Math.min(1, confidence * 0.1);

  if (reflex) {
    const setupScore = typeof reflex.metrics.setupScore === 'number' ? reflex.metrics.setupScore : confidence;
    const edgeScale = Number((config as any)?.reflexivity?.edgeScale ?? 0.2);
    expectedEdge = Math.min(1, clamp01(setupScore) * edgeScale);

    // Rough carry-cost penalty: when you are on the paying side of funding, reduce edge.
    const fundingRate = typeof reflex.metrics.fundingRate === 'number' ? reflex.metrics.fundingRate : 0;
    const paying =
      (side === 'buy' && fundingRate > 0) || (side === 'sell' && fundingRate < 0);
    if (paying) {
      const carryPenalty = Math.min(0.05, Math.abs(fundingRate) * 100); // heuristically cap at 5%
      expectedEdge = Math.max(0, expectedEdge - carryPenalty);
    }
  }

  const signalClass: ExpressionPlan['signalClass'] = hypothesis.id.includes('_revert')
    ? 'mean_reversion'
    : hypothesis.id.includes('_reflex')
      ? 'news_event'
      : hypothesis.id.includes('_trend')
        ? 'momentum_breakout'
        : 'unknown';

  const trend = Number(priceVol?.metrics?.trend ?? 0);
  const volZ = Number(priceVol?.metrics?.volZ ?? 0);
  const marketRegime: ExpressionPlan['marketRegime'] =
    volZ >= 1 ? 'high_vol_expansion' : volZ <= -0.5 ? 'low_vol_compression' : Math.abs(trend) >= 0.015 ? 'trending' : 'choppy';
  const volatilityBucket: ExpressionPlan['volatilityBucket'] =
    Math.abs(volZ) >= 1.2 ? 'high' : Math.abs(volZ) <= 0.4 ? 'low' : 'medium';
  const tradeCount = Number(orderflow?.metrics?.tradeCount ?? 0);
  const liquidityBucket: ExpressionPlan['liquidityBucket'] =
    tradeCount >= 18 ? 'deep' : tradeCount <= 4 ? 'thin' : 'normal';

  const newsTtlMinutes = Number((config.autonomy as any)?.newsEntry?.thesisTtlMinutes ?? 120);
  const noveltyScore =
    typeof reflex?.metrics?.setupScore === 'number' ? clamp01(Number(reflex.metrics.setupScore)) : confidence;
  const marketConfirmationScore = clamp01(Math.abs(Number(orderflow?.metrics?.imbalance ?? 0)) * 2);
  const liquidityScore = clamp01(tradeCount / 20);
  const volatilityScore = clamp01(Math.abs(volZ));
  const isNewsEvent = signalClass === 'news_event';

  return {
    id: `expr_${hypothesis.id}`,
    hypothesisId: hypothesis.id,
    symbol: cluster.symbol,
    side,
    signalClass,
    marketRegime,
    volatilityBucket,
    liquidityBucket,
    confidence,
    expectedEdge,
    entryZone: 'market',
    invalidation: hypothesis.invalidation,
    expectedMove: hypothesis.expectedExpression,
    orderType: 'market',
    leverage,
    probeSizeUsd: probeBudget,
    newsTrigger: isNewsEvent
      ? {
          enabled: true,
          subtype: 'catalyst_reflexivity',
          sources: [
            {
              source: 'discovery_reflexivity',
              ref: hypothesis.id,
              confidence: confidence,
            },
          ],
          noveltyScore,
          marketConfirmationScore,
          liquidityScore,
          volatilityScore,
          expiresAtMs: Date.now() + Math.max(10, newsTtlMinutes) * 60_000,
        }
      : null,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
