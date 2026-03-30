/**
 * signal-cache-integration.test.ts
 *
 * Integration tests verifying that each signal function deduplicates API calls
 * via the module-level TTL cache. The unit tests in signal-cache.test.ts only
 * cover TTLCache in isolation; these tests confirm the actual signal functions
 * wire the cache correctly (i.e., a second call with the same args returns a
 * cached value without invoking the underlying client again).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before vi.mock() factory closures run
// ---------------------------------------------------------------------------

const {
  mockCandleSnapshot,
  mockGetMetaAndAssetCtxs,
  mockGetFundingHistory,
  mockGetRecentTrades,
  mockBuildReflexivitySetup,
} = vi.hoisted(() => ({
  mockCandleSnapshot: vi.fn(async ({ coin }: { coin: string }) =>
    Array.from({ length: 80 }, (_, i) => ({
      t: Date.now() - (80 - i) * 3_600_000,
      T: Date.now() - (80 - i - 1) * 3_600_000,
      s: coin,
      i: '1h',
      o: String(40000 + i * 10 + coin.length),
      h: String(40010 + i * 10 + coin.length),
      l: String(39990 + i * 10 + coin.length),
      c: String(40000 + i * 10 + coin.length),
      v: '100',
      n: 10,
    }))
  ),
  mockGetMetaAndAssetCtxs: vi.fn(async () => [
    { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
    [
      { funding: '0.0001', openInterest: '5000000' },
      { funding: '-0.00005', openInterest: '2000000' },
    ],
  ] as const),
  mockGetFundingHistory: vi.fn(async () => [
    { fundingRate: '0.0001' },
    { fundingRate: '0.00012' },
  ]),
  mockGetRecentTrades: vi.fn(async () => [
    { px: '70000', sz: '0.5', side: 'B' },
    { px: '70010', sz: '0.3', side: 'A' },
    { px: '70020', sz: '0.7', side: 'B' },
  ]),
  mockBuildReflexivitySetup: vi.fn(async () => ({
    baseSymbol: 'BTC',
    symbol: 'BTC/USDT',
    directionalBias: 'up' as const,
    confidence: 0.6,
    timeHorizon: 'hours' as const,
    metrics: { crowding: 0.4, fragility: 0.3, catalyst: 0.5, setupScore: 0.7 },
  })),
}));

vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: vi.fn(() => ({
    getInfoClient: () => ({ candleSnapshot: mockCandleSnapshot }),
    getMergedMetaAndAssetCtxs: mockGetMetaAndAssetCtxs,
    getFundingHistory: mockGetFundingHistory,
    getRecentTrades: mockGetRecentTrades,
  })),
}));

vi.mock('../../src/reflexivity/fragility.js', () => ({
  buildReflexivitySetup: mockBuildReflexivitySetup,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are hoisted)
// ---------------------------------------------------------------------------

import {
  signalPriceVolRegime,
  signalCrossAssetDivergence,
  signalHyperliquidFundingOISkew,
  signalHyperliquidOrderflowImbalance,
  signalReflexivityFragility,
  clearSignalCache,
  getSignalCacheForTesting,
} from '../../src/discovery/signals.js';

const baseConfig = {} as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks(): void {
  mockCandleSnapshot.mockClear();
  mockGetMetaAndAssetCtxs.mockClear();
  mockGetFundingHistory.mockClear();
  mockGetRecentTrades.mockClear();
  mockBuildReflexivitySetup.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('signal cache integration — deduplication across calls', () => {
  beforeEach(() => {
    clearSignalCache();
    resetMocks();
  });

  // ─── signalPriceVolRegime ────────────────────────────────────────────────

  describe('signalPriceVolRegime', () => {
    it('first call hits HL candleSnapshot; second call returns cached result', async () => {
      const first = await signalPriceVolRegime(baseConfig, 'BTC/USDT');
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(1);
      expect(first).not.toBeNull();

      const second = await signalPriceVolRegime(baseConfig, 'BTC/USDT');
      // Must NOT call candleSnapshot again — cache hit
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('different symbols have independent cache entries', async () => {
      await signalPriceVolRegime(baseConfig, 'BTC/USDT');
      await signalPriceVolRegime(baseConfig, 'ETH/USDT');
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(2);

      // Calling both again → still 2 total (both cached)
      await signalPriceVolRegime(baseConfig, 'BTC/USDT');
      await signalPriceVolRegime(baseConfig, 'ETH/USDT');
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(2);
    });

    it('clearSignalCache() invalidates the entry so next call is a miss', async () => {
      await signalPriceVolRegime(baseConfig, 'BTC/USDT');
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(1);

      clearSignalCache();

      await signalPriceVolRegime(baseConfig, 'BTC/USDT');
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(2);
    });

    it('returns null and does NOT cache when candles are insufficient (<30)', async () => {
      mockCandleSnapshot.mockResolvedValueOnce(
        Array.from({ length: 20 }, (_, i) => ({
          t: Date.now() - (20 - i) * 3_600_000,
          T: Date.now() - (20 - i - 1) * 3_600_000,
          s: 'THIN',
          i: '1h',
          o: String(100 + i),
          h: String(101 + i),
          l: String(99 + i),
          c: String(100 + i),
          v: '10',
          n: 1,
        }))
      );
      const result = await signalPriceVolRegime(baseConfig, 'THIN/USDT');
      expect(result).toBeNull();

      // Next call should NOT be from cache — client called again
      await signalPriceVolRegime(baseConfig, 'THIN/USDT');
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(2);
    });

    it('returns null and caches it when candle fetch throws for an unsupported symbol', async () => {
      mockCandleSnapshot.mockRejectedValueOnce(new Error('unknown coin HYPE'));

      const first = await signalPriceVolRegime(baseConfig, 'HYPE/USDT');
      expect(first).toBeNull();
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(1);

      const second = await signalPriceVolRegime(baseConfig, 'HYPE/USDT');
      expect(second).toBeNull();
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  // ─── signalCrossAssetDivergence ─────────────────────────────────────────

  describe('signalCrossAssetDivergence', () => {
    it('first call hits HL candleSnapshot for each symbol; second call is cached', async () => {
      const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
      const first = await signalCrossAssetDivergence(baseConfig, symbols);
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(3);
      expect(Array.isArray(first)).toBe(true);

      const second = await signalCrossAssetDivergence(baseConfig, symbols);
      // No additional calls — cache hit
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(3);
      expect(second).toEqual(first);
    });

    it('cache key is order-independent (sorted symbols)', async () => {
      await signalCrossAssetDivergence(baseConfig, ['ETH/USDT', 'BTC/USDT']);
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(2);

      // Reversed order → same cache key
      await signalCrossAssetDivergence(baseConfig, ['BTC/USDT', 'ETH/USDT']);
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(2);
    });

    it('clears correctly and forces a new fetch', async () => {
      const symbols = ['BTC/USDT', 'ETH/USDT'];
      await signalCrossAssetDivergence(baseConfig, symbols);
      clearSignalCache();
      await signalCrossAssetDivergence(baseConfig, symbols);
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(4); // 2 + 2
    });

    it('returns [] for fewer than 2 symbols without hitting the client', async () => {
      const result = await signalCrossAssetDivergence(baseConfig, ['BTC/USDT']);
      expect(result).toEqual([]);
      expect(mockCandleSnapshot).not.toHaveBeenCalled();
    });

    it('skips unsupported symbols when candle fetch throws and caches the reduced result', async () => {
      mockCandleSnapshot.mockImplementation(async ({ coin }: { coin: string }) => {
        if (coin === 'HYPE') {
          throw new Error('unknown coin HYPE');
        }
        return Array.from({ length: 40 }, (_, i) => ({
          t: Date.now() - (40 - i) * 3_600_000,
          T: Date.now() - (40 - i - 1) * 3_600_000,
          s: coin,
          i: '1h',
          o: String(40000 + i * 10 + coin.length),
          h: String(40010 + i * 10),
          l: String(39990 + i * 10),
          c: String(40000 + i * 10 + coin.length),
          v: '100',
          n: 10,
        }));
      });

      const first = await signalCrossAssetDivergence(baseConfig, ['BTC/USDT', 'ETH/USDT', 'HYPE/USDT']);
      expect(Array.isArray(first)).toBe(true);
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(3);

      const second = await signalCrossAssetDivergence(baseConfig, ['ETH/USDT', 'HYPE/USDT', 'BTC/USDT']);
      expect(second).toEqual(first);
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(3);
    });

    it('returns [] and caches it when fewer than 2 supported symbols remain after fetch failures', async () => {
      mockCandleSnapshot.mockImplementation(async ({ coin }: { coin: string }) => {
        if (coin !== 'BTC') {
          throw new Error(`unknown coin ${coin}`);
        }
        return Array.from({ length: 40 }, (_, i) => ({
          t: Date.now() - (40 - i) * 3_600_000,
          T: Date.now() - (40 - i - 1) * 3_600_000,
          s: coin,
          i: '1h',
          o: String(40000 + i),
          h: String(40010 + i),
          l: String(39990 + i),
          c: String(40000 + i),
          v: '100',
          n: 10,
        }));
      });

      const first = await signalCrossAssetDivergence(baseConfig, ['BTC/USDT', 'HYPE/USDT']);
      expect(first).toEqual([]);
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(2);

      const second = await signalCrossAssetDivergence(baseConfig, ['HYPE/USDT', 'BTC/USDT']);
      expect(second).toEqual([]);
      expect(mockCandleSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  // ─── signalHyperliquidFundingOISkew ─────────────────────────────────────

  describe('signalHyperliquidFundingOISkew', () => {
    it('first call hits HyperliquidClient; second call returns cached result', async () => {
      const first = await signalHyperliquidFundingOISkew(baseConfig, 'BTC');
      expect(mockGetMetaAndAssetCtxs).toHaveBeenCalledTimes(1);
      expect(first).not.toBeNull();

      const second = await signalHyperliquidFundingOISkew(baseConfig, 'BTC');
      expect(mockGetMetaAndAssetCtxs).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('normalizes symbol (BTC/USDT → BTC) and shares cache entry', async () => {
      const a = await signalHyperliquidFundingOISkew(baseConfig, 'BTC');
      const b = await signalHyperliquidFundingOISkew(baseConfig, 'BTC/USDT');
      // Both resolve to coin='BTC', so only 1 client call
      expect(mockGetMetaAndAssetCtxs).toHaveBeenCalledTimes(1);
      expect(a).toEqual(b);
    });

    it('returns null and does not cache when coin not in universe', async () => {
      const result = await signalHyperliquidFundingOISkew(baseConfig, 'UNKNOWN');
      expect(result).toBeNull();
      // Next call should still hit the client (null result not cached for missing coin)
      await signalHyperliquidFundingOISkew(baseConfig, 'UNKNOWN');
      expect(mockGetMetaAndAssetCtxs).toHaveBeenCalledTimes(2);
    });

    it('clearSignalCache() forces re-fetch', async () => {
      await signalHyperliquidFundingOISkew(baseConfig, 'BTC');
      clearSignalCache();
      await signalHyperliquidFundingOISkew(baseConfig, 'BTC');
      expect(mockGetMetaAndAssetCtxs).toHaveBeenCalledTimes(2);
    });

    it('treats Hyperliquid 429s as temporary null results and caches the cooldown', async () => {
      mockGetMetaAndAssetCtxs.mockRejectedValueOnce(
        Object.assign(new Error('429 Too Many Requests - null'), { response: { status: 429 } })
      );

      const first = await signalHyperliquidFundingOISkew(baseConfig, 'BTC');
      expect(first).toBeNull();
      expect(mockGetMetaAndAssetCtxs).toHaveBeenCalledTimes(1);

      const second = await signalHyperliquidFundingOISkew(baseConfig, 'BTC');
      expect(second).toBeNull();
      expect(mockGetMetaAndAssetCtxs).toHaveBeenCalledTimes(1);
    });
  });

  // ─── signalHyperliquidOrderflowImbalance ────────────────────────────────

  describe('signalHyperliquidOrderflowImbalance', () => {
    it('first call hits HyperliquidClient; second call returns cached result', async () => {
      const first = await signalHyperliquidOrderflowImbalance(baseConfig, 'BTC');
      expect(mockGetRecentTrades).toHaveBeenCalledTimes(1);
      expect(first).not.toBeNull();

      const second = await signalHyperliquidOrderflowImbalance(baseConfig, 'BTC');
      expect(mockGetRecentTrades).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('null result from empty trades is NOT cached (early return before cache.set)', async () => {
      mockGetRecentTrades.mockResolvedValueOnce([]);
      const result = await signalHyperliquidOrderflowImbalance(baseConfig, 'THIN');
      expect(result).toBeNull();

      // Unlike reflexivity (which explicitly caches null), orderflow returns
      // null early before reaching signalCache.set() — so second call re-hits client.
      await signalHyperliquidOrderflowImbalance(baseConfig, 'THIN');
      expect(mockGetRecentTrades).toHaveBeenCalledTimes(2);
    });

    it('clearSignalCache() forces re-fetch', async () => {
      await signalHyperliquidOrderflowImbalance(baseConfig, 'ETH');
      clearSignalCache();
      await signalHyperliquidOrderflowImbalance(baseConfig, 'ETH');
      expect(mockGetRecentTrades).toHaveBeenCalledTimes(2);
    });

    it('treats Hyperliquid 429s as temporary null results and caches the cooldown', async () => {
      mockGetRecentTrades.mockRejectedValueOnce(
        Object.assign(new Error('429 Too Many Requests - null'), { response: { status: 429 } })
      );

      const first = await signalHyperliquidOrderflowImbalance(baseConfig, 'BTC');
      expect(first).toBeNull();
      expect(mockGetRecentTrades).toHaveBeenCalledTimes(1);

      const second = await signalHyperliquidOrderflowImbalance(baseConfig, 'BTC');
      expect(second).toBeNull();
      expect(mockGetRecentTrades).toHaveBeenCalledTimes(1);
    });
  });

  // ─── signalReflexivityFragility ─────────────────────────────────────────

  describe('signalReflexivityFragility', () => {
    it('first call hits buildReflexivitySetup; second call returns cached result', async () => {
      const first = await signalReflexivityFragility(baseConfig, 'BTC/USDT');
      expect(mockBuildReflexivitySetup).toHaveBeenCalledTimes(1);
      expect(first).not.toBeNull();

      const second = await signalReflexivityFragility(baseConfig, 'BTC/USDT');
      expect(mockBuildReflexivitySetup).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('null setup result is cached (avoids repeated reflexivity computation)', async () => {
      mockBuildReflexivitySetup.mockResolvedValueOnce(null);
      const result = await signalReflexivityFragility(baseConfig, 'NOREFL/USDT');
      expect(result).toBeNull();

      // Second call — buildReflexivitySetup must NOT be called again
      await signalReflexivityFragility(baseConfig, 'NOREFL/USDT');
      expect(mockBuildReflexivitySetup).toHaveBeenCalledTimes(1);
    });

    it('clearSignalCache() forces re-computation', async () => {
      await signalReflexivityFragility(baseConfig, 'BTC/USDT');
      clearSignalCache();
      await signalReflexivityFragility(baseConfig, 'BTC/USDT');
      expect(mockBuildReflexivitySetup).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Custom TTL via signalCacheTtlSeconds ────────────────────────────────

  describe('custom TTL via discovery.signalCacheTtlSeconds', () => {
    it('re-fetches after TTL expires when signalCacheTtlSeconds is 1', async () => {
      vi.useFakeTimers();
      try {
        clearSignalCache();
        mockCandleSnapshot.mockClear();

        const shortTtlConfig = { discovery: { signalCacheTtlSeconds: 1 } } as any;

        // First call — cache miss, client invoked
        await signalPriceVolRegime(shortTtlConfig, 'BTC/USDT');
        expect(mockCandleSnapshot).toHaveBeenCalledTimes(1);

        // Still within TTL → cache hit
        vi.advanceTimersByTime(500);
        await signalPriceVolRegime(shortTtlConfig, 'BTC/USDT');
        expect(mockCandleSnapshot).toHaveBeenCalledTimes(1);

        // Past TTL → cache miss, client invoked again
        vi.advanceTimersByTime(600);
        await signalPriceVolRegime(shortTtlConfig, 'BTC/USDT');
        expect(mockCandleSnapshot).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ─── Cross-signal isolation ──────────────────────────────────────────────

  describe('cache isolation between signal types', () => {
    it('price_vol and reflexivity use separate cache keys for the same symbol', async () => {
      await signalPriceVolRegime(baseConfig, 'BTC/USDT');
      await signalReflexivityFragility(baseConfig, 'BTC/USDT');

      const cache = getSignalCacheForTesting();
      expect(cache.has('price_vol:BTC/USDT')).toBe(true);
      expect(cache.has('reflexivity:BTC/USDT')).toBe(true);

      // Clearing and re-running one does not affect the other
      clearSignalCache();
      await signalPriceVolRegime(baseConfig, 'BTC/USDT');
      expect(cache.has('price_vol:BTC/USDT')).toBe(true);
      expect(cache.has('reflexivity:BTC/USDT')).toBe(false);
    });
  });
});
