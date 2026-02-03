import ccxt from 'ccxt';

import type { ThufirConfig } from '../core/config.js';
import type { OHLCV, Timeframe } from './types.js';

type CacheEntry<T> = {
  timestamp: number;
  value: T;
};

const DEFAULT_CACHE_TTL_MS: Record<Timeframe, number> = {
  '1m': 15_000,
  '5m': 30_000,
  '15m': 60_000,
  '1h': 5 * 60_000,
  '4h': 10 * 60_000,
  '1d': 30 * 60_000,
};

export class PriceService {
  private exchange: any;
  private cache = new Map<string, CacheEntry<OHLCV[]>>();
  private tickerCache = new Map<string, CacheEntry<number>>();

  constructor(private config: ThufirConfig) {
    this.exchange = this.createExchange();
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit = 100): Promise<OHLCV[]> {
    const key = `${symbol}|${timeframe}|${limit}`;
    const cached = this.cache.get(key);
    const ttl = DEFAULT_CACHE_TTL_MS[timeframe] ?? 30_000;
    if (cached && Date.now() - cached.timestamp < ttl) {
      return cached.value;
    }

    const ohlcv = (await this.exchange.fetchOHLCV(
      symbol,
      timeframe,
      undefined,
      limit
    )) as Array<[number, number, number, number, number, number]>;
    const mapped = ohlcv.map(([timestamp, open, high, low, close, volume]) => ({
      timestamp,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }));

    this.cache.set(key, { timestamp: Date.now(), value: mapped });
    return mapped;
  }

  async getPrice(symbol: string): Promise<number> {
    const cached = this.tickerCache.get(symbol);
    if (cached && Date.now() - cached.timestamp < 15_000) {
      return cached.value;
    }

    const ticker = await this.exchange.fetchTicker(symbol);
    const price = Number(ticker.last ?? ticker.close ?? ticker.bid ?? 0);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Failed to fetch price for ${symbol}`);
    }
    this.tickerCache.set(symbol, { timestamp: Date.now(), value: price });
    return price;
  }

  subscribe(symbol: string, callback: (price: number) => void): () => void {
    const intervalMs = 10_000;
    let active = true;

    const tick = async () => {
      if (!active) return;
      try {
        const price = await this.getPrice(symbol);
        callback(price);
      } catch {
        // ignore transient errors
      }
    };

    const timer = setInterval(tick, intervalMs);
    void tick();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }

  private createExchange(): any {
    const source = this.config.technical?.priceSource ?? 'binance';
    if (source === 'coinbase') {
      return new ccxt.coinbase({ enableRateLimit: true });
    }
    if (source === 'coingecko') {
      throw new Error('coingecko priceSource is not supported via ccxt; use binance or coinbase.');
    }
    return new ccxt.binance({ enableRateLimit: true });
  }
}
