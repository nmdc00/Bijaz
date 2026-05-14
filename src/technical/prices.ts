import ccxt from 'ccxt';

import type { ThufirConfig } from '../core/config.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
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

type PriceRoute =
  | { kind: 'exchange'; cacheSymbol: string; exchangeSymbol: string }
  | { kind: 'hyperliquid'; cacheSymbol: string; coin: string };

export class PriceService {
  private exchange: any;
  private cache = new Map<string, CacheEntry<OHLCV[]>>();
  private tickerCache = new Map<string, CacheEntry<number>>();
  private supportedSymbolsPromise: Promise<Set<string> | null> | null = null;
  private supportedHyperliquidSymbolsPromise: Promise<Set<string> | null> | null = null;

  constructor(private config: ThufirConfig) {
    this.exchange = this.createExchange();
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit = 100): Promise<OHLCV[]> {
    const route = await this.resolveRoute(symbol);
    const key = `${route.kind}:${route.cacheSymbol}|${timeframe}|${limit}`;
    const cached = this.cache.get(key);
    const ttl = DEFAULT_CACHE_TTL_MS[timeframe] ?? 30_000;
    if (cached && Date.now() - cached.timestamp < ttl) {
      return cached.value;
    }

    const mapped =
      route.kind === 'exchange'
        ? this.mapExchangeCandles(
            (await this.exchange.fetchOHLCV(
              route.exchangeSymbol,
              timeframe,
              undefined,
              limit
            )) as Array<[number, number, number, number, number, number]>
          )
        : await this.fetchHyperliquidCandles(route.coin, timeframe, limit);

    this.cache.set(key, { timestamp: Date.now(), value: mapped });
    return mapped;
  }

  async getPrice(symbol: string): Promise<number> {
    const route = await this.resolveRoute(symbol);
    const key = `${route.kind}:${route.cacheSymbol}`;
    const cached = this.tickerCache.get(key);
    if (cached && Date.now() - cached.timestamp < 15_000) {
      return cached.value;
    }

    const price =
      route.kind === 'exchange'
        ? await this.fetchExchangePrice(route.exchangeSymbol)
        : await this.fetchHyperliquidPrice(route.coin, route.cacheSymbol);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Failed to fetch price for ${route.cacheSymbol}`);
    }
    this.tickerCache.set(key, { timestamp: Date.now(), value: price });
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

  async supportsSymbol(symbol: string): Promise<boolean> {
    const exchangeSymbol = this.normalizeSymbolForExchange(symbol);
    const supportedSymbols = await this.getSupportedSymbols();
    if (exchangeSymbol && supportedSymbols?.has(exchangeSymbol)) {
      return true;
    }

    const hyperliquidRoute = this.normalizeSymbolForHyperliquid(symbol);
    if (hyperliquidRoute) {
      const supportedHyperliquidSymbols = await this.getSupportedHyperliquidSymbols();
      if (
        supportedHyperliquidSymbols === null ||
        supportedHyperliquidSymbols.has(hyperliquidRoute.cacheSymbol)
      ) {
        return true;
      }
    }

    if (exchangeSymbol && supportedSymbols === null) {
      return true;
    }
    return false;
  }

  private normalizeSymbolForExchange(symbol: string): string | null {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized || normalized.includes(':')) return null;

    if (normalized.includes('/')) {
      const [base, quote] = normalized.split('/', 2);
      if (!base || !quote) return null;
      return `${base}/${quote}`;
    }

    const source = this.config.technical?.priceSource ?? 'binance';
    return source === 'coinbase' ? `${normalized}/USD` : `${normalized}/USDT`;
  }

  private normalizeSymbolForHyperliquid(
    symbol: string
  ): { cacheSymbol: string; coin: string } | null {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return null;

    const [withoutQuote] = normalized.split('/');
    const market = withoutQuote ?? normalized;
    if (!market) return null;

    const colonIdx = market.indexOf(':');
    const coin =
      colonIdx < 0
        ? market
        : `${market.slice(0, colonIdx).toLowerCase()}:${market.slice(colonIdx + 1)}`;

    return {
      cacheSymbol: market,
      coin,
    };
  }

  private async resolveRoute(symbol: string): Promise<PriceRoute> {
    const exchangeSymbol = this.normalizeSymbolForExchange(symbol);
    const supportedSymbols = exchangeSymbol ? await this.getSupportedSymbols() : null;
    if (exchangeSymbol && supportedSymbols?.has(exchangeSymbol)) {
      return {
        kind: 'exchange',
        cacheSymbol: exchangeSymbol,
        exchangeSymbol,
      };
    }

    const hyperliquidRoute = this.normalizeSymbolForHyperliquid(symbol);
    if (hyperliquidRoute) {
      const supportedHyperliquidSymbols = await this.getSupportedHyperliquidSymbols();
      if (
        supportedHyperliquidSymbols === null ||
        supportedHyperliquidSymbols.has(hyperliquidRoute.cacheSymbol)
      ) {
        return {
          kind: 'hyperliquid',
          cacheSymbol: hyperliquidRoute.cacheSymbol,
          coin: hyperliquidRoute.coin,
        };
      }
    }

    if (exchangeSymbol && supportedSymbols === null) {
      return {
        kind: 'exchange',
        cacheSymbol: exchangeSymbol,
        exchangeSymbol,
      };
    }

    const source = this.config.technical?.priceSource ?? 'binance';
    throw new Error(`Unsupported ${source} technical price symbol: ${symbol}`);
  }

  private mapExchangeCandles(
    ohlcv: Array<[number, number, number, number, number, number]>
  ): OHLCV[] {
    return ohlcv.map(([timestamp, open, high, low, close, volume]) => ({
      timestamp,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }));
  }

  private async fetchExchangePrice(symbol: string): Promise<number> {
    const ticker = await this.exchange.fetchTicker(symbol);
    return Number(ticker.last ?? ticker.close ?? ticker.bid ?? 0);
  }

  private async fetchHyperliquidCandles(
    coin: string,
    timeframe: Timeframe,
    limit: number
  ): Promise<OHLCV[]> {
    const startTime = Date.now() - this.getTimeframeMs(timeframe) * limit;
    const client = new HyperliquidClient(this.config);
    const candles = await client.getCandleSnapshot({ coin, interval: timeframe, startTime });
    return candles.map((candle) => ({
      timestamp: candle.t,
      open: Number(candle.o),
      high: Number(candle.h),
      low: Number(candle.l),
      close: Number(candle.c),
      volume: Number(candle.v),
    }));
  }

  private async fetchHyperliquidPrice(coin: string, cacheSymbol: string): Promise<number> {
    const client = new HyperliquidClient(this.config);
    const mids = await client.getAllMids();
    for (const candidate of [cacheSymbol, coin, cacheSymbol.toUpperCase(), coin.toUpperCase()]) {
      const price = mids[candidate];
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
        return price;
      }
    }
    throw new Error(`Failed to fetch price for ${cacheSymbol}`);
  }

  private getTimeframeMs(timeframe: Timeframe): number {
    switch (timeframe) {
      case '1m':
        return 60_000;
      case '5m':
        return 5 * 60_000;
      case '15m':
        return 15 * 60_000;
      case '1h':
        return 60 * 60_000;
      case '4h':
        return 4 * 60 * 60_000;
      case '1d':
        return 24 * 60 * 60_000;
    }
  }

  private async getSupportedHyperliquidSymbols(): Promise<Set<string> | null> {
    if (!this.supportedHyperliquidSymbolsPromise) {
      const client = new HyperliquidClient(this.config);
      this.supportedHyperliquidSymbolsPromise = client
        .getMergedMetaAndAssetCtxs()
        .then(([meta]) => {
          const symbols = meta.universe
            .map((market) => market.name?.trim().toUpperCase())
            .filter((market): market is string => Boolean(market));
          return new Set(symbols);
        })
        .catch(() => null);
    }
    return this.supportedHyperliquidSymbolsPromise;
  }

  private async getSupportedSymbols(): Promise<Set<string> | null> {
    if (!this.supportedSymbolsPromise) {
      this.supportedSymbolsPromise = this.exchange
        .loadMarkets()
        .then((markets: Record<string, { symbol?: string }>) => {
          const symbols = Object.values(markets)
            .map((market) => market.symbol?.trim().toUpperCase())
            .filter((symbol): symbol is string => Boolean(symbol));
          return new Set(symbols);
        })
        .catch(() => null);
    }
    return this.supportedSymbolsPromise;
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
