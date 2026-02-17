export type TradeArchetype = 'scalp' | 'intraday' | 'swing';

export type InvalidationType = 'price_level' | 'structure_break';

export type TrailMode = 'none' | 'atr' | 'structure';

export interface EntryTradeContractInput {
  tradeArchetype?: string | null;
  invalidationType?: string | null;
  invalidationPrice?: number | null;
  timeStopAtMs?: number | null;
  takeProfitR?: number | null;
  trailMode?: string | null;
}

export interface EntryTradeContract {
  tradeArchetype: TradeArchetype;
  invalidationType: InvalidationType;
  invalidationPrice: number | null;
  timeStopAtMs: number;
  takeProfitR: number | null;
  trailMode: TrailMode;
}

type ContractValidationResult =
  | { valid: true; contract: EntryTradeContract | null }
  | { valid: false; error: string };

const MIN_HOLD_MS_BY_ARCHETYPE: Record<TradeArchetype, number> = {
  scalp: 5 * 60 * 1000,
  intraday: 30 * 60 * 1000,
  swing: 4 * 60 * 60 * 1000,
};

function normalizeArchetype(raw: string | null | undefined): TradeArchetype | null {
  if (raw === 'scalp' || raw === 'intraday' || raw === 'swing') return raw;
  return null;
}

function normalizeInvalidationType(raw: string | null | undefined): InvalidationType | null {
  if (raw === 'price_level' || raw === 'structure_break') return raw;
  return null;
}

function normalizeTrailMode(raw: string | null | undefined): TrailMode | null {
  if (raw === 'none' || raw === 'atr' || raw === 'structure') return raw;
  return null;
}

export function validateEntryTradeContract(params: {
  enabled: boolean;
  reduceOnly: boolean;
  input: EntryTradeContractInput;
  nowMs?: number;
}): ContractValidationResult {
  if (!params.enabled || params.reduceOnly) {
    return { valid: true, contract: null };
  }

  const nowMs = params.nowMs ?? Date.now();
  const archetype = normalizeArchetype(params.input.tradeArchetype);
  if (!archetype) {
    return { valid: false, error: 'Missing/invalid trade_archetype (scalp|intraday|swing)' };
  }

  const invalidationType = normalizeInvalidationType(params.input.invalidationType);
  if (!invalidationType) {
    return {
      valid: false,
      error: 'Missing/invalid invalidation_type (price_level|structure_break)',
    };
  }

  const timeStopAtMs = Number(params.input.timeStopAtMs);
  if (!Number.isFinite(timeStopAtMs) || timeStopAtMs <= nowMs) {
    return { valid: false, error: 'Missing/invalid time_stop_at_ms (must be in the future)' };
  }
  const minHoldMs = MIN_HOLD_MS_BY_ARCHETYPE[archetype];
  if (timeStopAtMs - nowMs < minHoldMs) {
    return {
      valid: false,
      error: `time_stop_at_ms too close for ${archetype} (minimum hold ${Math.floor(minHoldMs / 60000)}m)`,
    };
  }

  let invalidationPrice: number | null = null;
  if (invalidationType === 'price_level') {
    invalidationPrice = Number(params.input.invalidationPrice);
    if (!Number.isFinite(invalidationPrice) || invalidationPrice <= 0) {
      return {
        valid: false,
        error: 'invalidation_price is required and must be > 0 for invalidation_type=price_level',
      };
    }
  }

  const takeProfitRRaw = params.input.takeProfitR;
  const takeProfitR =
    takeProfitRRaw != null && Number.isFinite(Number(takeProfitRRaw)) ? Number(takeProfitRRaw) : null;
  const trailMode = normalizeTrailMode(params.input.trailMode ?? null);
  if (trailMode == null) {
    return { valid: false, error: 'Missing/invalid trail_mode (none|atr|structure)' };
  }
  if (takeProfitR == null && trailMode === 'none') {
    return {
      valid: false,
      error: 'Trade contract requires take_profit_r or trail_mode!=none',
    };
  }
  if (takeProfitR != null && takeProfitR <= 0) {
    return { valid: false, error: 'take_profit_r must be > 0 when provided' };
  }

  return {
    valid: true,
    contract: {
      tradeArchetype: archetype,
      invalidationType,
      invalidationPrice,
      timeStopAtMs,
      takeProfitR,
      trailMode,
    },
  };
}
