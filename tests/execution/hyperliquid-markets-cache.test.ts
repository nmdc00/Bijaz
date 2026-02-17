import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listPerpMarketsMock = vi.fn();
const getAllMidsMock = vi.fn();

vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: class {
    listPerpMarkets = listPerpMarketsMock;
    getAllMids = getAllMidsMock;
  },
}));

describe('HyperliquidMarketClient cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:00:00.000Z'));
    listPerpMarketsMock.mockReset();
    getAllMidsMock.mockReset();
    listPerpMarketsMock.mockResolvedValue([
      { symbol: 'BTC', assetId: 0, maxLeverage: 10, szDecimals: 3 },
      { symbol: 'ETH', assetId: 1, maxLeverage: 10, szDecimals: 3 },
    ]);
    getAllMidsMock.mockResolvedValue({ BTC: 100000, ETH: 3000 });
    process.env.THUFIR_MARKET_META_CACHE_TTL_MS = '600000';
    process.env.THUFIR_MARKET_MIDS_CACHE_TTL_MS = '30000';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.THUFIR_MARKET_META_CACHE_TTL_MS;
    delete process.env.THUFIR_MARKET_MIDS_CACHE_TTL_MS;
  });

  it('reuses cached market metadata and mids across repeated getMarket calls', async () => {
    const { HyperliquidMarketClient } = await import('../../src/execution/hyperliquid/markets.js');
    const client = new HyperliquidMarketClient({ hyperliquid: { enabled: true } } as any);

    await client.getMarket('BTC');
    await client.getMarket('ETH');

    expect(listPerpMarketsMock).toHaveBeenCalledTimes(1);
    expect(getAllMidsMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes cache after TTL expiry', async () => {
    process.env.THUFIR_MARKET_META_CACHE_TTL_MS = '1000';
    process.env.THUFIR_MARKET_MIDS_CACHE_TTL_MS = '1000';
    const { HyperliquidMarketClient } = await import('../../src/execution/hyperliquid/markets.js');
    const client = new HyperliquidMarketClient({ hyperliquid: { enabled: true } } as any);

    await client.getMarket('BTC');
    vi.setSystemTime(new Date('2026-02-17T00:00:02.000Z'));
    await client.getMarket('BTC');

    expect(listPerpMarketsMock).toHaveBeenCalledTimes(2);
    expect(getAllMidsMock).toHaveBeenCalledTimes(2);
  });
});
