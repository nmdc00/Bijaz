import { describe, expect, it, vi } from 'vitest';

const storeDecisionArtifact = vi.fn();

vi.mock('../../src/memory/decision_artifacts.js', () => ({
  storeDecisionArtifact,
}));

vi.mock('../../src/discovery/signals.js', () => ({
  signalPriceVolRegime: async (_config: unknown, symbol: string) => ({
    id: `pv_${symbol}`,
    kind: 'price_vol_regime',
    symbol,
    directionalBias: 'up',
    confidence: 0.72,
    timeHorizon: 'hours',
    metrics: { trend: 0.02, volZ: 0.5 },
  }),
  signalCrossAssetDivergence: async () => [],
  signalHyperliquidFundingOISkew: async () => null,
  signalHyperliquidOrderflowImbalance: async () => null,
  signalReflexivityFragility: async () => null,
}));

describe('runDiscovery context pack enrichment', () => {
  it('adds full context pack with graceful defaults when providers are sparse/missing', async () => {
    const { runDiscovery } = await import('../../src/discovery/engine.js');

    const result = await runDiscovery(
      {
        hyperliquid: { symbols: ['BTC'] },
        wallet: { limits: { daily: 100 } },
        autonomy: { probeRiskFraction: 0.01 },
      } as any,
      {
        contextPackProviders: {
          executionQuality: async () => ({
            status: 'good',
            score: 0.81,
            notes: ['fills stable'],
          }),
          event: async () => {
            throw new Error('provider timeout');
          },
        },
      }
    );

    expect(result.expressions.length).toBeGreaterThan(0);
    const contextPack = result.expressions[0]?.contextPack;
    expect(contextPack).toBeTruthy();
    expect(contextPack?.regime.marketRegime).toBe('trending');
    expect(contextPack?.executionQuality.status).toBe('good');
    expect(contextPack?.event.kind).toBe('technical');
    expect(contextPack?.portfolioState.posture).toBe('unknown');
    expect(contextPack?.missing).toContain('regime.provider');
    expect(contextPack?.missing).toContain('portfolioState.provider');
  });

  it('keeps context pack complete when no providers are configured', async () => {
    const { runDiscovery } = await import('../../src/discovery/engine.js');

    const result = await runDiscovery({
      hyperliquid: { symbols: ['ETH'] },
      wallet: { limits: { daily: 100 } },
      autonomy: { probeRiskFraction: 0.01 },
    } as any);

    const contextPack = result.expressions[0]?.contextPack;
    expect(contextPack).toBeTruthy();
    expect(contextPack?.regime).toBeTruthy();
    expect(contextPack?.executionQuality).toBeTruthy();
    expect(contextPack?.event).toBeTruthy();
    expect(contextPack?.portfolioState).toBeTruthy();
  });
});
