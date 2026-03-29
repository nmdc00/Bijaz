/**
 * Regression tests for DEX-prefixed symbol normalization in signal functions.
 *
 * Bug: "FLX:GOLD" and "km:USENERGY" all returned "Insufficient data" because
 * normalizeHyperliquidSymbol() only stripped "/quote" suffixes, not "PREFIX:" prefixes,
 * and signalPriceVolRegime never normalized at all before hitting Binance.
 *
 * Fix: normalizeHyperliquidSymbol now strips the colon prefix first, then the slash suffix.
 *      signalPriceVolRegime now calls normalizeHyperliquidSymbol and appends "/USDT".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ThufirConfig } from '../../src/core/config.js';

// ── PriceService mock ────────────────────────────────────────────────────────
// Binance knows bare "GOLD/USDT" but not "FLX:GOLD" or "km:USENERGY"
// (USENERGY is a HL-native equity proxy — no Binance equivalent)
const BINANCE_KNOWN = new Set(['GOLD/USDT', 'GOLD']);
vi.mock('../../src/technical/prices.js', () => ({
  PriceService: class {
    async getCandles(symbol: string) {
      if (!BINANCE_KNOWN.has(symbol)) {
        throw new Error(`binance does not have market symbol ${symbol}`);
      }
      return Array.from({ length: 80 }, (_, i) => ({
        timestamp: Date.now() - (80 - i) * 3_600_000,
        open: 2000,
        high: 2010,
        low: 1990,
        close: 2000 + i * 0.1,
        volume: 1000,
      }));
    }
  },
}));

// ── HyperliquidClient mock ───────────────────────────────────────────────────
// Universe stores bare names ("GOLD", "USENERGY") — not "FLX:GOLD" / "km:USENERGY"
vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: class {
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
      // HL trades API expects bare coin names — returns empty for anything with a colon
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
describe('signalPriceVolRegime — DEX prefix normalization', () => {
  it('resolves FLX:GOLD → GOLD/USDT on Binance and returns a signal', async () => {
    const result = await signalPriceVolRegime(config, 'FLX:GOLD');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('price_vol_regime');
    expect(result?.symbol).toBe('FLX:GOLD'); // original symbol preserved on output
  });

  it('still returns null for km:USENERGY (Binance has no USENERGY — separate data gap)', async () => {
    const result = await signalPriceVolRegime(config, 'km:USENERGY');
    expect(result).toBeNull();
  });

  it('returns a signal for bare GOLD/USDT (unchanged behaviour)', async () => {
    const result = await signalPriceVolRegime(config, 'GOLD/USDT');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('price_vol_regime');
  });
});

// ── signalHyperliquidFundingOISkew ───────────────────────────────────────────
describe('signalHyperliquidFundingOISkew — DEX prefix normalization', () => {
  it('resolves FLX:GOLD → GOLD and finds it in the HL universe', async () => {
    const result = await signalHyperliquidFundingOISkew(config, 'FLX:GOLD');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('funding_oi_skew');
  });

  it('resolves km:USENERGY → USENERGY and finds it in the HL universe', async () => {
    const result = await signalHyperliquidFundingOISkew(config, 'km:USENERGY');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('funding_oi_skew');
  });

  it('returns a signal for bare GOLD (unchanged behaviour)', async () => {
    const result = await signalHyperliquidFundingOISkew(config, 'GOLD');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('funding_oi_skew');
  });
});

// ── signalHyperliquidOrderflowImbalance ──────────────────────────────────────
describe('signalHyperliquidOrderflowImbalance — DEX prefix normalization', () => {
  it('resolves FLX:GOLD → GOLD and fetches trades successfully', async () => {
    const result = await signalHyperliquidOrderflowImbalance(config, 'FLX:GOLD');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('orderflow_imbalance');
  });

  it('resolves km:USENERGY → USENERGY and fetches trades successfully', async () => {
    const result = await signalHyperliquidOrderflowImbalance(config, 'km:USENERGY');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('orderflow_imbalance');
  });

  it('returns a signal for bare GOLD (unchanged behaviour)', async () => {
    const result = await signalHyperliquidOrderflowImbalance(config, 'GOLD');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('orderflow_imbalance');
  });
});
