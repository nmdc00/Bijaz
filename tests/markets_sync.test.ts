import { describe, expect, it, vi } from 'vitest';

import { refreshMarketPrices, syncMarketCache } from '../src/core/markets_sync.js';

const storedBatches: Array<Array<{ id: string }>> = [];
const listMarketsMock = vi.fn();

vi.mock('../src/memory/market_cache.js', () => ({
  upsertMarketCacheBatch: (records: Array<{ id: string }>) => {
    storedBatches.push(records);
  },
}));

vi.mock('../src/execution/augur/markets.js', () => ({
  AugurMarketClient: class {
    async listMarkets() {
      return listMarketsMock();
    }
  },
}));

describe('markets_sync', () => {
  it('paginates and stores all pages', async () => {
    storedBatches.length = 0;
    listMarketsMock.mockResolvedValueOnce([
      { id: 'm1', question: 'Q1', outcomes: [], prices: {} },
      { id: 'm2', question: 'Q2', outcomes: [], prices: {} },
    ]);
    const result = await syncMarketCache({} as any, 2, 5);
    expect(result.stored).toBe(2);
    expect(storedBatches.length).toBe(1);
  });

  it('refreshes market prices from Augur client', async () => {
    storedBatches.length = 0;
    listMarketsMock.mockResolvedValueOnce([
      { id: 'm3', question: 'Q3', outcomes: [], prices: {} },
    ]);
    const result = await refreshMarketPrices({} as any, 100);
    expect(result.stored).toBe(1);
    expect(storedBatches.length).toBe(1);
    expect(storedBatches[0][0].id).toBe('m3');
  });
});
