import type { ThufirConfig } from './config.js';
import { createMarketClient } from '../execution/market-client.js';
import {
  listDuePredictionsForResolution,
  markPredictionResolutionError,
} from '../memory/predictions.js';
import { recordOutcome } from '../memory/calibration.js';

function extractYesPrice(prices: Record<string, number> | undefined): number | null {
  if (!prices) {
    return null;
  }
  const direct =
    prices.YES ??
    prices.Yes ??
    prices.yes ??
    prices['1'] ??
    prices.true ??
    prices.TRUE;
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }
  const firstNumeric = Object.values(prices).find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );
  return firstNumeric ?? null;
}

export async function resolveOutcomes(
  config: ThufirConfig,
  limit = 25,
  asOf = new Date()
): Promise<number> {
  let updated = 0;
  const marketClient = createMarketClient(config);
  if (!marketClient.isAvailable()) {
    return 0;
  }
  const asOfIso = asOf.toISOString();
  const due = listDuePredictionsForResolution(asOfIso, limit);
  for (const prediction of due) {
    try {
      if (!prediction.predictedOutcome) {
        markPredictionResolutionError({
          id: prediction.id,
          error: 'Prediction is missing predicted outcome.',
          metadata: {
            asOf: asOfIso,
            expiresAt: prediction.expiresAt,
            reason: 'missing_predicted_outcome',
          },
          resolutionTimestamp: asOfIso,
        });
        updated += 1;
        continue;
      }

      const market = await marketClient.getMarket(prediction.marketId);
      const resolution = market.resolution?.toUpperCase();
      const resolvedOutcome =
        resolution === 'YES' || resolution === 'NO' ? resolution : null;
      const snapshotYesPrice = extractYesPrice(market.prices);

      if (!resolvedOutcome && snapshotYesPrice === null) {
        markPredictionResolutionError({
          id: prediction.id,
          error: 'Unable to derive snapshot outcome from market prices.',
          metadata: {
            asOf: asOfIso,
            expiresAt: prediction.expiresAt,
            reason: 'missing_snapshot_price',
            marketId: prediction.marketId,
          },
          resolutionTimestamp: asOfIso,
        });
        updated += 1;
        continue;
      }

      const outcome = (resolvedOutcome ?? (snapshotYesPrice! >= 0.5 ? 'YES' : 'NO')) as
        | 'YES'
        | 'NO';
      recordOutcome({
        id: prediction.id,
        outcome,
        outcomeTimestamp: asOfIso,
        resolutionMetadata: {
          basis: resolvedOutcome ? 'market_resolution' : 'snapshot_threshold',
          asOf: asOfIso,
          expiresAt: prediction.expiresAt,
          horizonMinutes: prediction.horizonMinutes ?? null,
          snapshotYesPrice,
        },
      });
      updated += 1;
    } catch (error) {
      markPredictionResolutionError({
        id: prediction.id,
        error:
          error instanceof Error ? error.message : 'Unexpected resolver failure.',
        metadata: {
          asOf: asOfIso,
          expiresAt: prediction.expiresAt,
          reason: 'market_fetch_failed',
          marketId: prediction.marketId,
        },
        resolutionTimestamp: asOfIso,
      });
      updated += 1;
    }
  }
  return updated;
}
