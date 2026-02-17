import { describe, expect, it, vi } from 'vitest';

const getMetaAndAssetCtxs = vi.fn(async () => [
  {
    universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'DOGE' }, { name: 'SOL' }],
  },
  [
    { markPx: 70000, oraclePx: 70010, openInterest: 25_000, dayNtlVlm: 2_000_000_000, funding: 0.0001 },
    { markPx: 3500, oraclePx: 3501, openInterest: 80_000, dayNtlVlm: 1_600_000_000, funding: 0.00005 },
    { markPx: 0.2, oraclePx: 0.2, openInterest: 3_000_000, dayNtlVlm: 50_000_000, funding: 0.0008 },
    { markPx: 130, oraclePx: 130.5, openInterest: 200_000, dayNtlVlm: 500_000_000, funding: 0.0002 },
  ],
]);

vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: class {
    async getMetaAndAssetCtxs() {
      return getMetaAndAssetCtxs();
    }
  },
}));

describe('selectDiscoveryMarkets', () => {
  it('returns configured symbols directly when an allowlist exists', async () => {
    const { selectDiscoveryMarkets } = await import('../../src/discovery/market_selector.js');
    const result = await selectDiscoveryMarkets({
      hyperliquid: { symbols: ['BTC', 'ETH'] },
      autonomy: { discoverySelection: { fullUniverseWhenSymbolsEmpty: true } },
    } as any);

    expect(result.source).toBe('configured');
    expect(result.candidates.map((c) => c.symbol)).toEqual(['BTC', 'ETH']);
    expect(getMetaAndAssetCtxs).not.toHaveBeenCalled();
  });

  it('ranks full universe when symbols are empty and full-universe mode is enabled', async () => {
    getMetaAndAssetCtxs.mockClear();
    const { selectDiscoveryMarkets } = await import('../../src/discovery/market_selector.js');
    const result = await selectDiscoveryMarkets({
      hyperliquid: { symbols: [] },
      autonomy: {
        discoverySelection: {
          fullUniverseWhenSymbolsEmpty: true,
          preselectLimit: 3,
          minOpenInterestUsd: 1_000_000,
          minDayVolumeUsd: 10_000_000,
        },
      },
    } as any);

    expect(result.source).toBe('full_universe');
    expect(result.candidates.length).toBe(3);
    expect(result.candidates[0]?.symbol).toBe('BTC');
    expect(result.candidates.some((c) => c.symbol === 'DOGE')).toBe(false);
    expect(getMetaAndAssetCtxs).toHaveBeenCalledTimes(1);
  });
});
