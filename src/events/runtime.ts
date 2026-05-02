import type { LlmClient } from '../core/llm.js';
import type { ThufirConfig } from '../core/config.js';
import { PriceService } from '../technical/prices.js';
import type { Timeframe } from '../technical/types.js';
import { listIntelByIds } from '../intel/store.js';
import { getLatestThought, listForecastsForEvent } from '../memory/events.js';
import { createForecastsFromThought, type MarketMoveSnapshot } from './outcomes.js';
import { generateThoughtForEvent } from './thoughts.js';
import type { EventForecast, EventThought, NormalizedEvent } from './types.js';

export interface MaterializeEventPipelineOptions {
  llm?: LlmClient;
  horizonHours?: number[];
  perAssetLimit?: number;
  minimumConfidence?: number;
}

export interface MaterializeEventPipelineResult {
  eventsSeen: number;
  thoughtsCreated: number;
  thoughtsSkipped: number;
  forecastsCreated: number;
  forecastsSkipped: number;
}

type CandleLike = {
  timestamp: number;
  close: number;
};

type PriceResolver = Pick<PriceService, 'supportsSymbol' | 'getCandles'>;

function pickTimeframe(forecast: EventForecast): Timeframe {
  if (forecast.horizonHours <= 24) return '1h';
  if (forecast.horizonHours <= 96) return '4h';
  return '1d';
}

function resolveSymbolCandidates(asset: string): string[] {
  const normalized = asset.trim().toUpperCase();
  return Array.from(
    new Set([normalized, `${normalized}/USDT`, `${normalized}/USD`, `${normalized}/USDC`])
  );
}

function candleNearestToTimestamp(
  candles: CandleLike[],
  targetMs: number,
  mode: 'at_or_before' | 'at_or_after'
): CandleLike | null {
  let best: CandleLike | null = null;
  for (const candle of candles) {
    if (mode === 'at_or_before' && candle.timestamp > targetMs) continue;
    if (mode === 'at_or_after' && candle.timestamp < targetMs) continue;
    if (!best) {
      best = candle;
      continue;
    }
    if (mode === 'at_or_before' && candle.timestamp > best.timestamp) {
      best = candle;
    }
    if (mode === 'at_or_after' && candle.timestamp < best.timestamp) {
      best = candle;
    }
  }
  return best;
}

async function fetchForecastCandles(
  resolver: PriceResolver,
  forecast: EventForecast
): Promise<{ symbol: string; candles: CandleLike[] } | null> {
  const timeframe = pickTimeframe(forecast);
  const limit = timeframe === '1h' ? 240 : timeframe === '4h' ? 180 : 120;

  for (const candidate of resolveSymbolCandidates(forecast.asset)) {
    try {
      const supported = await resolver.supportsSymbol(candidate);
      if (!supported) continue;
      const candles = await resolver.getCandles(candidate, timeframe, limit);
      if (candles.length > 0) {
        return { symbol: candidate, candles };
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function materializeThoughtsAndForecastsForEvents(
  config: ThufirConfig,
  events: NormalizedEvent[],
  options?: MaterializeEventPipelineOptions
): Promise<MaterializeEventPipelineResult> {
  let thoughtsCreated = 0;
  let thoughtsSkipped = 0;
  let forecastsCreated = 0;
  let forecastsSkipped = 0;

  for (const event of events) {
    const existingForecasts = listForecastsForEvent(event.id);
    if (existingForecasts.length > 0) {
      forecastsSkipped += 1;
      continue;
    }

    let thought: EventThought | null = getLatestThought(event.id);
    if (!thought) {
      thought = await generateThoughtForEvent(config, {
        event,
        intel: listIntelByIds(event.sourceIntelIds),
        llm: options?.llm,
      });
      if (thought) {
        thoughtsCreated += 1;
      } else {
        thoughtsSkipped += 1;
        continue;
      }
    } else {
      thoughtsSkipped += 1;
    }

    const created = createForecastsFromThought(thought, {
      horizonHours: options?.horizonHours,
      perAssetLimit: options?.perAssetLimit,
      minimumConfidence: options?.minimumConfidence,
    });
    if (created.length > 0) {
      forecastsCreated += created.length;
    } else {
      forecastsSkipped += 1;
    }
  }

  return {
    eventsSeen: events.length,
    thoughtsCreated,
    thoughtsSkipped,
    forecastsCreated,
    forecastsSkipped,
  };
}

export async function resolveForecastMoveWithPriceService(
  config: ThufirConfig,
  forecast: EventForecast,
  resolver: PriceResolver = new PriceService(config)
): Promise<MarketMoveSnapshot | null> {
  const resolved = await fetchForecastCandles(resolver, forecast);
  if (!resolved) {
    return null;
  }

  const createdAtMs = Date.parse(forecast.createdAt);
  const expiresAtMs = Date.parse(forecast.expiresAt);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs)) {
    return {
      startPrice: null,
      endPrice: null,
      note: `Invalid forecast timestamps for ${forecast.asset}.`,
    };
  }

  const startCandle =
    candleNearestToTimestamp(resolved.candles, createdAtMs, 'at_or_before') ??
    resolved.candles[0] ??
    null;
  const endCandle =
    candleNearestToTimestamp(resolved.candles, expiresAtMs, 'at_or_after') ??
    candleNearestToTimestamp(resolved.candles, expiresAtMs, 'at_or_before') ??
    resolved.candles[resolved.candles.length - 1] ??
    null;

  if (!startCandle || !endCandle) {
    return null;
  }

  return {
    startPrice: startCandle.close,
    endPrice: endCandle.close,
    asOf: new Date(endCandle.timestamp).toISOString(),
    note: `Resolved from ${resolved.symbol} ${pickTimeframe(forecast)} candles.`,
  };
}
