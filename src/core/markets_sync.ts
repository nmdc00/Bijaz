import type { BijazConfig } from './config.js';
import { PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { upsertMarketCacheBatch } from '../memory/market_cache.js';

export async function syncMarketCache(
  config: BijazConfig,
  limit = 200
): Promise<{ stored: number }> {
  const client = new PolymarketMarketClient(config);
  const markets = await client.listMarkets(limit);
  const records = markets.map((market) => ({
    id: market.id,
    question: market.question,
    outcomes: market.outcomes ?? [],
    prices: market.prices ?? {},
    volume: market.volume ?? null,
    liquidity: market.liquidity ?? null,
    endDate: market.endDate ?? null,
    category: market.category ?? null,
    resolved: market.resolved ?? false,
    resolution: market.resolution ?? null,
  }));
  if (records.length > 0) {
    upsertMarketCacheBatch(records);
  }
  return { stored: records.length };
}
