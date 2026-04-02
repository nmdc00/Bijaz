/**
 * Regression tests for DEX-prefixed symbol normalization in signal functions.
 *
 * Root cause: signalPriceVolRegime used ccxt/Binance (PriceService) which has no
 * knowledge of Hyperliquid-native markets like FLX:GOLD or km:USENERGY.
 * normalizeHyperliquidSymbol also failed to strip PREFIX: before the slash suffix.
 *
 * Fix:
 * - normalizeHyperliquidSymbol strips colon prefix first, then slash suffix
 * - signalPriceVolRegime now uses the Hyperliquid candleSnapshot API (not Binance)
 * - signalCrossAssetDivergence same
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ThufirConfig } from '../../src/core/config.js';

// ── Fake candle factory ──────────────────────────────────────────────────────
function makeCandles(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    t: Date.now() - (n - i) * 3_600_000,
    T: Date.now() - (n - i - 1) * 3_600_000,
    s: 'GOLD',
    i: '1h',
    o: String(2000 + i * 0.05),
    h: String(2010 + i * 0.05),
    l: String(1990 + i * 0.05),
    c: String(2000 + i * 0.1),
    v: '1000',
    n: 50,
  }));
}

// ── HyperliquidClient mock ───────────────────────────────────────────────────
// candleSnapshot returns data for bare coin names, throws for prefixed ones
vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: class {
    getInfoClient() {
      return {
        candleSnapshot: async ({ coin }: { coin: string }) => {
          // HL candle API: lowercase prefix works (flx:GOLD ✓), uppercase fails (FLX:GOLD → 500)
          // bare coin names only work for main perp markets (BTC, ETH), not DEX symbols
          const colonIdx = coin.indexOf(':');
          if (colonIdx >= 0 && coin.slice(0, colonIdx) !== coin.slice(0, colonIdx).toLowerCase()) {
            throw new Error('500 Internal Server Error');
          }
          if (colonIdx < 0 && !['BTC', 'ETH', 'GOLD', 'USENERGY'].includes(coin)) {
            throw new Error('500 Internal Server Error');
          }
          return makeCandles(80);
        },
      };
    }
    async getMergedMetaAndAssetCtxs() {
      return [
        { universe: [{ name: 'GOLD' }, { name: 'USENERGY' }] },
        [
          { funding: '0.0001', openInterest: '50000' },
          { funding: '-0.0002', openInterest: '20000' },
        ],
      ];
    }
    async getFundingHistory() {
      return [{ fundingRate: '0.0001' }, { fundingRate: '0.0002' }];
    }
    async getRecentTrades(coin: string) {
      if (coin.includes(':')) return [];
      return [
        { px: '2000', sz: '1', side: 'B' },
        { px: '2001', sz: '1', side: 'A' },
      ];
    }
  },
}));

import {
  signalPriceVolRegime,
  signalHyperliquidFundingOISkew,
  signalHyperliquidOrderflowImbalance,
  clearSignalCache,
} from '../../src/discovery/signals.js';

const config = {} as ThufirConfig;

beforeEach(() => clearSignalCache());

// ── signalPriceVolRegime ─────────────────────────────────────────────────────
describe('signalPriceVolRegime — DEX prefix normalization via HL candles', () => {
  it('resolves FLX:GOLD → GOLD and fetches HL candles successfully', async () => {
    const result = await signalPriceVolRegime(config, 'FLX:GOLD');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('price_vol_regime');
    expect(result?.symbol).toBe('FLX:GOLD');
  });

  it('resolves FLX:GOLD/USDC → GOLD and fetches HL candles successfully', async () => {
    const result = await signalPriceVolRegime(config, 'FLX:GOLD/USDC');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('price_vol_regime');
  });

  it('resolves km:USENERGY → USENERGY and fetches HL candles successfully', async () => {
    const result = await signalPriceVolRegime(config, 'km:USENERGY');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('price_vol_regime');
  });

  it('resolves km:USENERGY/USDC → USENERGY and fetches HL candles successfully', async () => {
    const result = await signalPriceVolRegime(config, 'km:USENERGY/USDC');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('price_vol_regime');
  });

  it('returns a signal for bare GOLD (unchanged behaviour)', async () => {
    const result = await signalPriceVolRegime(config, 'GOLD');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('price_vol_regime');
  });
});

// ── signalHyperliquidFundingOISkew ───────────────────────────────────────────
describe('signalHyperliquidFundingOISkew — DEX prefix normalization', () => {
  it('resolves FLX:GOLD → GOLD', async () => {
    const result = await signalHyperliquidFundingOISkew(config, 'FLX:GOLD');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('funding_oi_skew');
  });

  it('resolves FLX:GOLD/USDC → GOLD', async () => {
    const result = await signalHyperliquidFundingOISkew(config, 'FLX:GOLD/USDC');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('funding_oi_skew');
  });

  it('resolves km:USENERGY → USENERGY', async () => {
    const result = await signalHyperliquidFundingOISkew(config, 'km:USENERGY');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('funding_oi_skew');
  });

  it('resolves km:USENERGY/USDC → USENERGY', async () => {
    const result = await signalHyperliquidFundingOISkew(config, 'km:USENERGY/USDC');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('funding_oi_skew');
  });
});

// ── signalHyperliquidOrderflowImbalance ──────────────────────────────────────
describe('signalHyperliquidOrderflowImbalance — DEX prefix normalization', () => {
  it('resolves FLX:GOLD → GOLD and fetches trades', async () => {
    const result = await signalHyperliquidOrderflowImbalance(config, 'FLX:GOLD');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('orderflow_imbalance');
  });

  it('resolves FLX:GOLD/USDC → GOLD', async () => {
    const result = await signalHyperliquidOrderflowImbalance(config, 'FLX:GOLD/USDC');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('orderflow_imbalance');
  });

  it('resolves km:USENERGY → USENERGY', async () => {
    const result = await signalHyperliquidOrderflowImbalance(config, 'km:USENERGY');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('orderflow_imbalance');
  });

  it('resolves km:USENERGY/USDC → USENERGY', async () => {
    const result = await signalHyperliquidOrderflowImbalance(config, 'km:USENERGY/USDC');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('orderflow_imbalance');
  });
});
