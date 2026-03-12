import type { MarketClient } from '../execution/market-client.js';
import {
  getOutcomeForForecast,
  insertOutcome,
  listExpiredOpenForecasts,
  listOpenForecasts,
} from '../memory/events.js';
import type { EventForecast, EventOutcome } from './types.js';

export interface ForecastResolutionSweepResult {
  expired: EventOutcome[];
  unresolved: EventForecast[];
}

export function expireForecast(forecast: EventForecast, note?: string): EventOutcome {
  const existing = getOutcomeForForecast(forecast.id);
  if (existing) return existing;
  return insertOutcome({
    forecastId: forecast.id,
    eventId: forecast.eventId,
    resolutionStatus: 'expired',
    resolutionNote: note ?? 'Forecast horizon elapsed before a confirming observation was recorded.',
    actualDirection: 'unknown',
  });
}

export function sweepExpiredForecasts(): ForecastResolutionSweepResult {
  const expiredForecasts = listExpiredOpenForecasts();
  return {
    expired: expiredForecasts.map((forecast) => expireForecast(forecast)),
    unresolved: listOpenForecasts(),
  };
}

export async function collectForecastMarketSnapshot(
  marketClient: MarketClient,
  symbols: string[]
): Promise<Array<{ symbol: string; markPrice: number | null }>> {
  const unique = Array.from(new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean)));
  const rows: Array<{ symbol: string; markPrice: number | null }> = [];
  for (const symbol of unique) {
    try {
      const market = await marketClient.getMarket(symbol);
      rows.push({ symbol, markPrice: market.markPrice ?? null });
    } catch {
      rows.push({ symbol, markPrice: null });
    }
  }
  return rows;
}
