export interface TradePathMetricsInput {
  entrySide: 'buy' | 'sell';
  entryPrice: number | null;
  exitPrice?: number | null;
  pricePathHigh?: number | null;
  pricePathLow?: number | null;
  invalidationPrice?: number | null;
  openedAtMs?: number | null;
  closedAtMs?: number | null;
  firstConfirmationAtMs?: number | null;
  invalidatedAtMs?: number | null;
}

export interface TradePathMetrics {
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  timeToFirstConfirmationMs: number | null;
  timeSpentUnderwaterMs: number | null;
  timeToInvalidationMs: number | null;
  thesisWorkedLaterAfterStopout: boolean | null;
  betterTimedEntryAvailableLater: boolean | null;
  pathShapeMatchedHistory: boolean | null;
}

function toFinite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pct(delta: number, base: number): number | null {
  if (!Number.isFinite(delta) || !Number.isFinite(base) || base <= 0) return null;
  return delta / base;
}

export function computeTradePathMetrics(input: TradePathMetricsInput): TradePathMetrics {
  const entryPrice = toFinite(input.entryPrice);
  if (entryPrice == null || entryPrice <= 0) {
    return {
      maxFavorableExcursionPct: null,
      maxAdverseExcursionPct: null,
      timeToFirstConfirmationMs: null,
      timeSpentUnderwaterMs: null,
      timeToInvalidationMs: null,
      thesisWorkedLaterAfterStopout: null,
      betterTimedEntryAvailableLater: null,
      pathShapeMatchedHistory: null,
    };
  }

  const high = toFinite(input.pricePathHigh) ?? entryPrice;
  const low = toFinite(input.pricePathLow) ?? entryPrice;
  const exitPrice = toFinite(input.exitPrice);
  const invalidationPrice = toFinite(input.invalidationPrice);
  const favorableMove =
    input.entrySide === 'buy' ? Math.max(0, high - entryPrice) : Math.max(0, entryPrice - low);
  const adverseMove =
    input.entrySide === 'buy' ? Math.max(0, entryPrice - low) : Math.max(0, high - entryPrice);
  const betterTimedEntryAvailableLater =
    input.entrySide === 'buy'
      ? low < entryPrice * 0.995
      : high > entryPrice * 1.005;
  const thesisWorkedLaterAfterStopout =
    invalidationPrice != null && exitPrice != null
      ? input.entrySide === 'buy'
        ? low <= invalidationPrice && high > entryPrice
        : high >= invalidationPrice && low < entryPrice
      : null;

  return {
    maxFavorableExcursionPct: pct(favorableMove, entryPrice),
    maxAdverseExcursionPct: pct(adverseMove, entryPrice),
    timeToFirstConfirmationMs:
      input.firstConfirmationAtMs != null && input.openedAtMs != null
        ? Math.max(0, input.firstConfirmationAtMs - input.openedAtMs)
        : null,
    timeSpentUnderwaterMs:
      input.closedAtMs != null && input.openedAtMs != null && adverseMove > 0
        ? Math.max(0, input.closedAtMs - input.openedAtMs)
        : 0,
    timeToInvalidationMs:
      input.invalidatedAtMs != null && input.openedAtMs != null
        ? Math.max(0, input.invalidatedAtMs - input.openedAtMs)
        : null,
    thesisWorkedLaterAfterStopout,
    betterTimedEntryAvailableLater,
    pathShapeMatchedHistory:
      favorableMove > adverseMove ? true : favorableMove < adverseMove ? false : null,
  };
}
