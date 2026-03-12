import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeDecisionArtifact = vi.fn();
const signalPriceVolRegime = vi.fn();
const signalCrossAssetDivergence = vi.fn();
const signalHyperliquidFundingOISkew = vi.fn();
const signalHyperliquidOrderflowImbalance = vi.fn();
const signalReflexivityFragility = vi.fn();
const supportsSymbol = vi.fn();

vi.mock('../../src/memory/decision_artifacts.js', () => ({
  storeDecisionArtifact,
}));

vi.mock('../../src/discovery/signals.js', () => ({
  signalPriceVolRegime,
  signalCrossAssetDivergence,
  signalHyperliquidFundingOISkew,
  signalHyperliquidOrderflowImbalance,
  signalReflexivityFragility,
}));

vi.mock('../../src/discovery/hypotheses.js', () => ({
  generateHypotheses: vi.fn(() => []),
}));

vi.mock('../../src/discovery/expressions.js', () => ({
  mapExpressionPlan: vi.fn(),
  enrichExpressionContextPack: vi.fn(),
}));

vi.mock('../../src/technical/prices.js', () => ({
  PriceService: vi.fn(() => ({
    supportsSymbol,
  })),
}));

describe('runDiscovery technical symbol support filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    supportsSymbol.mockImplementation(async (symbol: string) => symbol !== 'HYPE/USDT');
    signalPriceVolRegime.mockImplementation(async (_config: unknown, symbol: string) => ({
      id: `pv_${symbol}`,
      kind: 'price_vol_regime',
      symbol,
      directionalBias: 'up',
      confidence: 0.6,
      timeHorizon: 'hours',
      metrics: {},
    }));
    signalCrossAssetDivergence.mockResolvedValue([]);
    signalHyperliquidFundingOISkew.mockImplementation(async (_config: unknown, symbol: string) => ({
      id: `funding_${symbol}`,
      kind: 'funding_oi_skew',
      symbol,
      directionalBias: 'neutral',
      confidence: 0.4,
      timeHorizon: 'hours',
      metrics: {},
    }));
    signalHyperliquidOrderflowImbalance.mockResolvedValue(null);
    signalReflexivityFragility.mockResolvedValue(null);
  });

  it('skips unsupported technical symbols but preserves Hyperliquid-native signals', async () => {
    const { runDiscovery } = await import('../../src/discovery/engine.js');

    const result = await runDiscovery({
      hyperliquid: { symbols: ['BTC', 'HYPE', 'ETH'] },
    } as any);

    expect(supportsSymbol).toHaveBeenCalledWith('BTC/USDT');
    expect(supportsSymbol).toHaveBeenCalledWith('HYPE/USDT');
    expect(supportsSymbol).toHaveBeenCalledWith('ETH/USDT');

    expect(signalPriceVolRegime).toHaveBeenCalledTimes(2);
    expect(signalPriceVolRegime).toHaveBeenCalledWith(expect.anything(), 'BTC/USDT');
    expect(signalPriceVolRegime).toHaveBeenCalledWith(expect.anything(), 'ETH/USDT');
    expect(signalPriceVolRegime).not.toHaveBeenCalledWith(expect.anything(), 'HYPE/USDT');

    expect(signalCrossAssetDivergence).toHaveBeenCalledTimes(1);
    expect(signalCrossAssetDivergence).toHaveBeenCalledWith(expect.anything(), ['BTC/USDT', 'ETH/USDT']);

    expect(signalHyperliquidFundingOISkew).toHaveBeenCalledTimes(3);
    expect(signalHyperliquidFundingOISkew).toHaveBeenCalledWith(expect.anything(), 'HYPE/USDT');

    const hypeCluster = result.clusters.find((cluster) => cluster.symbol === 'HYPE/USDT');
    expect(hypeCluster).toBeTruthy();
    expect(hypeCluster?.signals.some((signal) => signal.kind === 'price_vol_regime')).toBe(false);
    expect(hypeCluster?.signals.some((signal) => signal.kind === 'funding_oi_skew')).toBe(true);
  });
});
