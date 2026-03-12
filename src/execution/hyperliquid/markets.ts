import type { ThufirConfig } from '../../core/config.js';
import type { Market } from '../markets.js';
import { HyperliquidClient } from './client.js';

function normalizeMarketSymbol(value: string): string {
  return value.trim().toUpperCase();
}

function toBaseMarketSymbol(value: string): string {
  const normalized = normalizeMarketSymbol(value);
  const withoutQuote = normalized.split('/')[0] ?? normalized;
  const withoutDexPrefix = withoutQuote.includes(':')
    ? (withoutQuote.split(':').at(-1) ?? withoutQuote)
    : withoutQuote;
  return withoutDexPrefix;
}

function matchesMarketSymbol(candidate: string, query: string): boolean {
  const normalizedCandidate = normalizeMarketSymbol(candidate);
  const normalizedQuery = normalizeMarketSymbol(query);
  if (!normalizedCandidate || !normalizedQuery) return false;
  return (
    normalizedCandidate === normalizedQuery ||
    toBaseMarketSymbol(normalizedCandidate) === toBaseMarketSymbol(normalizedQuery)
  );
}

export class HyperliquidMarketClient {
  private client: HyperliquidClient;
  private symbols: string[];
  private marketMetaCache: { loadedAtMs: number; value: Awaited<ReturnType<HyperliquidClient['listPerpMarkets']>> } | null = null;
  private midsCache: { loadedAtMs: number; value: Record<string, number> } | null = null;
  private inflightMarketMeta: Promise<Awaited<ReturnType<HyperliquidClient['listPerpMarkets']>>> | null = null;
  private inflightMids: Promise<Record<string, number>> | null = null;

  constructor(private config: ThufirConfig) {
    this.client = new HyperliquidClient(config);
    this.symbols = config.hyperliquid?.symbols ?? [];
  }

  private getMarketMetaCacheTtlMs(): number {
    const raw = Number(process.env.THUFIR_MARKET_META_CACHE_TTL_MS ?? 10 * 60 * 1000);
    return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
  }

  private getMidsCacheTtlMs(): number {
    const raw = Number(process.env.THUFIR_MARKET_MIDS_CACHE_TTL_MS ?? 30 * 1000);
    return Number.isFinite(raw) && raw > 0 ? raw : 30 * 1000;
  }

  private isFresh(entry: { loadedAtMs: number } | null, ttlMs: number): boolean {
    if (!entry) return false;
    return Date.now() - entry.loadedAtMs <= ttlMs;
  }

  private async getCachedMarketMeta(): Promise<Awaited<ReturnType<HyperliquidClient['listPerpMarkets']>>>
  {
    if (this.isFresh(this.marketMetaCache, this.getMarketMetaCacheTtlMs())) {
      return this.marketMetaCache!.value;
    }
    if (this.inflightMarketMeta) {
      return this.inflightMarketMeta;
    }
    this.inflightMarketMeta = this.client
      .listPerpMarkets()
      .then((value) => {
        this.marketMetaCache = { loadedAtMs: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.inflightMarketMeta = null;
      });
    return this.inflightMarketMeta;
  }

  private async getCachedMids(): Promise<Record<string, number>> {
    if (this.isFresh(this.midsCache, this.getMidsCacheTtlMs())) {
      return this.midsCache!.value;
    }
    if (this.inflightMids) {
      return this.inflightMids;
    }
    this.inflightMids = this.client
      .getAllMids()
      .then((value) => {
        this.midsCache = { loadedAtMs: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.inflightMids = null;
      });
    return this.inflightMids;
  }

  isAvailable(): boolean {
    return this.config.hyperliquid?.enabled !== false;
  }

  async listMarkets(limit = 50): Promise<Market[]> {
    const [markets, mids] = await Promise.all([this.getCachedMarketMeta(), this.getCachedMids()]);
    const filtered = this.symbols.length
      ? markets.filter((m) => this.symbols.some((symbol) => matchesMarketSymbol(m.symbol, symbol)))
      : markets;
    return filtered.slice(0, limit).map((m) => ({
      id: m.symbol,
      question: `Perp: ${m.symbol}`,
      outcomes: ['LONG', 'SHORT'],
      prices: {},
      platform: 'hyperliquid',
      kind: 'perp',
      symbol: m.symbol,
      markPrice: mids[m.symbol],
      metadata: {
        assetId: m.assetId,
        maxLeverage: m.maxLeverage,
        szDecimals: m.szDecimals,
      },
    }));
  }

  async searchMarkets(query: string, limit = 10): Promise<Market[]> {
    const needle = query.toLowerCase();
    const markets = await this.listMarkets(500);
    const filtered = markets.filter((m) =>
      (m.symbol ?? m.id).toLowerCase().includes(needle)
    );
    return filtered.slice(0, limit);
  }

  async getMarket(symbol: string): Promise<Market> {
    const markets = await this.listMarkets(500);
    const match = markets.find((m) => matchesMarketSymbol(m.symbol ?? m.id, symbol) || matchesMarketSymbol(m.id, symbol));
    if (!match) {
      throw new Error(`Hyperliquid market not found: ${symbol}`);
    }
    return match;
  }
}
