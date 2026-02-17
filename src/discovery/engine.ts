import type { ThufirConfig } from '../core/config.js';
import { storeDecisionArtifact } from '../memory/decision_artifacts.js';
import type { SignalCluster, SignalPrimitive } from './types.js';
import {
  signalPriceVolRegime,
  signalCrossAssetDivergence,
  signalHyperliquidFundingOISkew,
  signalHyperliquidOrderflowImbalance,
  signalReflexivityFragility,
} from './signals.js';
import { generateHypotheses } from './hypotheses.js';
import { enrichExpressionContextPack, mapExpressionPlan, type ContextPackProviders } from './expressions.js';
import { selectDiscoveryMarkets } from './market_selector.js';

function clusterSignals(symbol: string, signals: Array<SignalPrimitive | null>): SignalCluster {
  const flat = signals.filter((s): s is NonNullable<typeof s> => !!s);
  const biasScore = flat.reduce((acc, s) => acc + (s.directionalBias === 'up' ? 1 : s.directionalBias === 'down' ? -1 : 0), 0);
  const directionalBias = biasScore > 0 ? 'up' : biasScore < 0 ? 'down' : 'neutral';
  const confidence = flat.length ? Math.min(1, flat.reduce((a, b) => a + b.confidence, 0) / flat.length) : 0;
  const timeHorizon = flat[0]?.timeHorizon ?? 'hours';
  return {
    id: `cluster_${symbol}_${Date.now()}`,
    symbol,
    signals: flat,
    directionalBias,
    confidence,
    timeHorizon,
  };
}

export async function runDiscovery(
  config: ThufirConfig,
  options?: { contextPackProviders?: ContextPackProviders; preselectLimit?: number }
): Promise<{
  clusters: SignalCluster[];
  hypotheses: ReturnType<typeof generateHypotheses>;
  expressions: ReturnType<typeof mapExpressionPlan>[];
  selector: {
    source: 'configured' | 'full_universe';
    symbols: string[];
  };
}> {
  const selectorEnabled = config.autonomy?.discoverySelection?.enabled ?? true;
  const selected = selectorEnabled
    ? await selectDiscoveryMarkets(config, {
        limit:
          options?.preselectLimit && Number.isFinite(options.preselectLimit)
            ? Math.max(1, Math.floor(options.preselectLimit))
            : undefined,
      })
    : null;
  const symbols = selected
    ? selected.candidates.map((item) => item.symbol)
    : (config.hyperliquid?.symbols?.length ? config.hyperliquid.symbols : ['BTC', 'ETH']);
  const formatted = symbols.map((s) => `${s}/USDT`);

  const priceSignals = await Promise.all(formatted.map((symbol) => signalPriceVolRegime(config, symbol)));
  const crossSignals = await signalCrossAssetDivergence(config, formatted);
  const fundingSignals = await Promise.all(
    formatted.map((symbol) => signalHyperliquidFundingOISkew(config, symbol))
  );
  const orderflowSignals = await Promise.all(
    formatted.map((symbol) => signalHyperliquidOrderflowImbalance(config, symbol))
  );
  const reflexivitySignals = await Promise.all(
    formatted.map((symbol) => signalReflexivityFragility(config, symbol))
  );

  const clusters = formatted.map((symbol, idx) => {
    const matchingCross = crossSignals.filter((s) => s.symbol === symbol);
    return clusterSignals(symbol, [
      priceSignals[idx] ?? null,
      fundingSignals[idx] ?? null,
      orderflowSignals[idx] ?? null,
      reflexivitySignals[idx] ?? null,
      ...matchingCross,
    ]);
  });

  const hypotheses = clusters.flatMap((cluster) => {
    const items = generateHypotheses(cluster);
    for (const hyp of items) {
      storeDecisionArtifact({
        source: 'discovery',
        kind: 'hypothesis',
        marketId: cluster.symbol,
        fingerprint: hyp.id,
        payload: hyp,
      });
    }
    return items;
  });

  const expressions = await Promise.all(hypotheses.map(async (hyp) => {
    const cluster = clusters.find((c) => c.id === hyp.clusterId)!;
    const expr = mapExpressionPlan(config, cluster, hyp);
    const enriched = await enrichExpressionContextPack({
      expression: expr,
      cluster,
      hypothesis: hyp,
      providers: options?.contextPackProviders,
    });
    storeDecisionArtifact({
      source: 'discovery',
      kind: 'expression',
      marketId: cluster.symbol,
      fingerprint: enriched.id,
      payload: enriched,
    });
    return enriched;
  }));

  for (const cluster of clusters) {
    storeDecisionArtifact({
      source: 'discovery',
      kind: 'signal_cluster',
      marketId: cluster.symbol,
      fingerprint: cluster.id,
      payload: cluster,
    });
  }

  return {
    clusters,
    hypotheses,
    expressions,
    selector: {
      source: selected?.source ?? 'configured',
      symbols,
    },
  };
}
