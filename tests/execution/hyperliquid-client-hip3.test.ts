import { describe, expect, it, vi } from 'vitest';

const metaMock = vi.fn();
const perpDexsMock = vi.fn();
const allMidsMock = vi.fn();
const metaAndAssetCtxsMock = vi.fn();

vi.mock('@nktkas/hyperliquid', () => ({
  HttpTransport: class {},
  InfoClient: class {
    meta = metaMock;
    perpDexs = perpDexsMock;
    allMids = allMidsMock;
    metaAndAssetCtxs = metaAndAssetCtxsMock;
  },
  ExchangeClient: class {},
}));

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: () => ({ address: '0x123' }),
}));

describe('HyperliquidClient HIP-3 discovery', () => {
  it('merges main dex and HIP-3 dex markets and mids', async () => {
    metaMock.mockImplementation(async (params?: { dex?: string }) => {
      if (params?.dex === 'xyz') {
        return {
          universe: [{ name: 'xyz:CL', szDecimals: 2, maxLeverage: 10 }],
        };
      }
      return {
        universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }],
      };
    });
    perpDexsMock.mockResolvedValue([null, { name: 'xyz' }]);
    allMidsMock.mockResolvedValue({ BTC: '70000.5' });
    metaAndAssetCtxsMock.mockResolvedValue([
      { universe: [{ name: 'xyz:CL', szDecimals: 2, maxLeverage: 10 }] },
      [{ markPx: '72.15' }],
    ]);

    const { HyperliquidClient } = await import('../../src/execution/hyperliquid/client.js');
    const client = new HyperliquidClient({ hyperliquid: { enabled: true } } as any);

    await expect(client.listPerpMarkets()).resolves.toEqual([
      { symbol: 'BTC', assetId: 0, dex: null, maxLeverage: 40, szDecimals: 5 },
      { symbol: 'xyz:CL', assetId: 0, dex: 'xyz', maxLeverage: 10, szDecimals: 2 },
    ]);
    await expect(client.getAllMids()).resolves.toEqual({
      BTC: 70000.5,
      'xyz:CL': 72.15,
    });
  });
});
