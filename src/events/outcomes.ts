import type { EventForecast, EventOutcome, EventThought, ForecastDirection } from './types.js';
import { validateForecastInput, validateOutcomeInput } from './types.js';
import {
  insertForecast,
  insertOutcome,
  listExpiredOpenForecasts,
} from '../memory/events.js';
import type { MarketClient } from '../execution/market-client.js';

export interface ForecastGenerationOptions {
  horizonHours?: number[];
  perAssetLimit?: number;
  minimumConfidence?: number;
}

export interface MarketMoveSnapshot {
  startPrice: number | null;
  endPrice: number | null;
  asOf?: string;
  note?: string;
}

export interface ResolveExpiredForecastsOptions {
  resolveMove: (forecast: EventForecast) => Promise<MarketMoveSnapshot | null>;
  neutralThresholdBps?: number;
}

export interface ResolvedForecastBatch {
  checked: number;
  resolved: number;
  outcomes: EventOutcome[];
}

type OutcomeInput = Parameters<typeof insertOutcome>[0];

const DEFAULT_HORIZONS = [24, 168];

function normalizeHorizonHours(input?: number[]): number[] {
  const horizons = Array.isArray(input) ? input : DEFAULT_HORIZONS;
  return Array.from(new Set(horizons.map((value) => Math.max(1, Math.round(value))))).sort(
    (left, right) => left - right
  );
}

function classifyDirection(
  startPrice: number,
  endPrice: number,
  neutralThresholdBps: number
): ForecastDirection | 'unknown' {
  if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice) || startPrice <= 0) {
    return 'unknown';
  }

  const moveBps = ((endPrice - startPrice) / startPrice) * 10_000;
  if (Math.abs(moveBps) < neutralThresholdBps) {
    return 'neutral';
  }
  return moveBps > 0 ? 'up' : 'down';
}

export function createForecastsFromThought(
  thought: EventThought,
  options?: ForecastGenerationOptions
): EventForecast[] {
  const horizons = normalizeHorizonHours(options?.horizonHours);
  const minimumConfidence = Math.min(Math.max(options?.minimumConfidence ?? 0, 0), 1);
  const perAssetLimit = Math.max(
    1,
    options?.perAssetLimit ?? (thought.impactedAssets.length ?? 1)
  );
  const assets = thought.impactedAssets
    .filter((asset) => asset.confidence >= minimumConfidence)
    .slice(0, perAssetLimit);

  const forecasts: EventForecast[] = [];
  for (const asset of assets) {
    for (const horizonHours of horizons) {
      const input = {
        eventId: thought.eventId,
        thoughtId: thought.id,
        asset: asset.symbol,
        domain: inferDomainForAsset(thought, asset.symbol),
        direction: asset.direction,
        horizonHours,
        confidence: asset.confidence,
        invalidationConditions: thought.invalidationConditions,
      };
      const validation = validateForecastInput(input);
      if (!validation.valid) {
        continue;
      }
      forecasts.push(insertForecast(input));
    }
  }

  return forecasts;
}

export function ensureForecastsForThought(
  _event: { id: string },
  thought: EventThought
): EventForecast[] {
  return createForecastsFromThought(thought, { horizonHours: [24] });
}

function inferDomainForAsset(thought: EventThought, symbol: string): string {
  const upper = symbol.toUpperCase();
  if (['CL', 'BRENTOIL', 'WTI', 'NATGAS'].includes(upper)) return 'energy';
  if (['WHEAT', 'CORN', 'COFFEE', 'COCOA', 'SOYBEAN'].includes(upper)) return 'agri';
  if (['GOLD', 'SILVER', 'COPPER'].includes(upper)) return 'metals';
  if (['DXY', 'EURUSD', 'USDJPY'].includes(upper)) return 'fx';
  if (['ZN', 'ZB', 'TLT'].includes(upper)) return 'rates';
  if (['BTC', 'ETH', 'SOL'].includes(upper)) return 'crypto';
  const modelVersion = (thought.modelVersion ?? '').toLowerCase();
  if (modelVersion.includes('energy')) return 'energy';
  return 'macro';
}

export function buildOutcomeForForecast(params: {
  forecast: EventForecast;
  snapshot: MarketMoveSnapshot | null;
  neutralThresholdBps?: number;
}): Parameters<typeof insertOutcome>[0] {
  const neutralThresholdBps = Math.max(1, params.neutralThresholdBps ?? 25);
  const startPrice = params.snapshot?.startPrice ?? null;
  const endPrice = params.snapshot?.endPrice ?? null;

  if (startPrice == null || endPrice == null) {
    const expired = {
      forecastId: params.forecast.id,
      eventId: params.forecast.eventId,
      resolutionStatus: 'expired' as const,
      resolutionNote: params.snapshot?.note ?? 'No market move data available at forecast expiry.',
      actualDirection: 'unknown' as const,
      resolutionPrice: endPrice ?? undefined,
    };
    const validation = validateOutcomeInput(expired);
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }
    return expired;
  }

  const actualDirection = classifyDirection(startPrice, endPrice, neutralThresholdBps);
  const resolutionStatus: OutcomeInput['resolutionStatus'] =
    actualDirection === 'unknown'
      ? 'error'
      : actualDirection === params.forecast.direction
        ? 'confirmed'
        : actualDirection === 'neutral'
          ? 'expired'
          : 'invalidated';

  const outcome: OutcomeInput = {
    forecastId: params.forecast.id,
    eventId: params.forecast.eventId,
    resolutionStatus,
    resolutionNote:
      params.snapshot?.note ??
      `Resolved from ${startPrice} to ${endPrice} with actual direction ${actualDirection}.`,
    actualDirection,
    resolutionPrice: endPrice,
  };
  const validation = validateOutcomeInput(outcome);
  if (!validation.valid) {
    throw new Error(validation.errors.join('; '));
  }
  return outcome;
}

export async function resolveExpiredForecasts(
  options: ResolveExpiredForecastsOptions
): Promise<ResolvedForecastBatch> {
  const due = listExpiredOpenForecasts();
  const outcomes: EventOutcome[] = [];

  for (const forecast of due) {
    const snapshot = await options.resolveMove(forecast);
    const outcomeInput = buildOutcomeForForecast({
      forecast,
      snapshot,
      neutralThresholdBps: options.neutralThresholdBps,
    });
    outcomes.push(insertOutcome(outcomeInput));
  }

  return {
    checked: due.length,
    resolved: outcomes.length,
    outcomes,
  };
}

export async function collectForecastMarketSnapshot(
  marketClient: MarketClient,
  symbols: string[]
): Promise<Array<{ symbol: string; markPrice: number | null }>> {
  const unique = Array.from(new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean)));
  const snapshots: Array<{ symbol: string; markPrice: number | null }> = [];

  for (const symbol of unique) {
    try {
      const market = await marketClient.getMarket(symbol);
      snapshots.push({
        symbol,
        markPrice: typeof market.markPrice === 'number' ? market.markPrice : null,
      });
    } catch {
      snapshots.push({ symbol, markPrice: null });
    }
  }

  return snapshots;
}

export function sweepExpiredForecasts(): { expired: EventForecast[]; unresolved: EventForecast[] } {
  try {
    const expired = listExpiredOpenForecasts();
    return { expired, unresolved: expired };
  } catch {
    return { expired: [], unresolved: [] };
  }
}
