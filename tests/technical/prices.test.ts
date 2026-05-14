import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchOHLCV = vi.fn();
const fetchTicker = vi.fn();
const loadMarkets = vi.fn();
const getAllMids = vi.fn();
const getMergedMetaAndAssetCtxs = vi.fn();
const getCandleSnapshot = vi.fn();

vi.mock('ccxt', () => ({
  default: {
    binance: vi.fn(() => ({
      fetchOHLCV,
      fetchTicker,
      loadMarkets,
    })),
    coinbase: vi.fn(() => ({
      fetchOHLCV,
      fetchTicker,
      loadMarkets,
    })),
  },
}));

vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: vi.fn(() => ({
    getAllMids,
    getMergedMetaAndAssetCtxs,
    getCandleSnapshot,
  })),
}));

import { PriceService } from '../../src/technical/prices.js';

describe('PriceService routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchOHLCV.mockResolvedValue([
      [1_710_000_000_000, 100, 110, 95, 105, 1_234],
    ]);
    fetchTicker.mockResolvedValue({ last: 250 });
    loadMarkets.mockResolvedValue({
      'BTC/USDT': { symbol: 'BTC/USDT' },
      'ETH/USDT': { symbol: 'ETH/USDT' },
    });
    getMergedMetaAndAssetCtxs.mockResolvedValue([
      {
        universe: [
          { name: 'HYPE' },
          { name: 'XYZ:CL' },
          { name: 'XYZ:BRENTOIL' },
        ],
      },
      [],
    ]);
    getCandleSnapshot.mockResolvedValue([
      { t: 1_710_000_000_000, o: '100', h: '110', l: '95', c: '105', v: '1234' },
    ]);
    getAllMids.mockResolvedValue({
      HYPE: 42,
      'XYZ:CL': 78.5,
      'xyz:CL': 78.5,
    });
  });

  it('normalizes bare binance symbols to USDT pairs for candles', async () => {
    const service = new PriceService({ technical: { priceSource: 'binance' } } as any);

    const candles = await service.getCandles('BTC', '1h', 10);

    expect(fetchOHLCV).toHaveBeenCalledWith('BTC/USDT', '1h', undefined, 10);
    expect(getCandleSnapshot).not.toHaveBeenCalled();
    expect(candles[0]?.close).toBe(105);
  });

  it('normalizes bare binance symbols to USDT pairs for spot prices', async () => {
    const service = new PriceService({ technical: { priceSource: 'binance' } } as any);

    const price = await service.getPrice('ETH');

    expect(fetchTicker).toHaveBeenCalledWith('ETH/USDT');
    expect(getAllMids).not.toHaveBeenCalled();
    expect(price).toBe(250);
  });

  it('falls back to Hyperliquid candles for symbols unsupported on Binance but present in HL universe', async () => {
    const service = new PriceService({ technical: { priceSource: 'binance' } } as any);

    const candles = await service.getCandles('XYZ:CL', '1h', 24);

    expect(fetchOHLCV).not.toHaveBeenCalled();
    expect(getCandleSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ coin: 'xyz:CL', interval: '1h' })
    );
    expect(candles[0]?.close).toBe(105);
  });

  it('falls back to Hyperliquid mids for unsupported Binance symbols present in HL universe', async () => {
    const service = new PriceService({ technical: { priceSource: 'binance' } } as any);

    const price = await service.getPrice('HYPE');

    expect(fetchTicker).not.toHaveBeenCalled();
    expect(getAllMids).toHaveBeenCalledTimes(1);
    expect(price).toBe(42);
  });

  it('treats HL universe symbols as supported when Binance does not list them', async () => {
    const service = new PriceService({ technical: { priceSource: 'binance' } } as any);

    await expect(service.supportsSymbol('XYZ:BRENTOIL')).resolves.toBe(true);
  });

  it('rejects symbols unsupported by both Binance and Hyperliquid', async () => {
    const service = new PriceService({ technical: { priceSource: 'binance' } } as any);

    await expect(service.supportsSymbol('NOPE')).resolves.toBe(false);
    await expect(service.getCandles('NOPE', '1h')).rejects.toThrow(
      'Unsupported binance technical price symbol: NOPE'
    );
    await expect(service.getPrice('NOPE')).rejects.toThrow(
      'Unsupported binance technical price symbol: NOPE'
    );
  });

  it('uses Coinbase USD normalization when configured', async () => {
    const service = new PriceService({ technical: { priceSource: 'coinbase' } } as any);
    loadMarkets.mockResolvedValue({
      'BTC/USD': { symbol: 'BTC/USD' },
    });

    await service.getCandles('BTC', '1h', 5);

    expect(fetchOHLCV).toHaveBeenCalledWith('BTC/USD', '1h', undefined, 5);
    expect(getCandleSnapshot).not.toHaveBeenCalled();
  });
});
