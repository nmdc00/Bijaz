import type { ThufirConfig } from '../core/config.js';
import type { TechnicalSnapshot, Timeframe } from './types.js';
import { PriceService } from './prices.js';
import { buildTechnicalSnapshot } from './indicators.js';

export async function getTechnicalSnapshot(params: {
  config: ThufirConfig;
  symbol: string;
  timeframe: Timeframe;
  limit?: number;
}): Promise<TechnicalSnapshot> {
  const priceService = new PriceService(params.config);
  const candles = await priceService.getCandles(params.symbol, params.timeframe, params.limit ?? 120);
  if (candles.length === 0) {
    throw new Error(`No candles returned for ${params.symbol} ${params.timeframe}`);
  }
  return buildTechnicalSnapshot({
    symbol: params.symbol,
    timeframe: params.timeframe,
    candles,
    config: params.config,
  });
}
