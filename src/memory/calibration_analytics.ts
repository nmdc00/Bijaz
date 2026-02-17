import { openDatabase } from './db.js';

export interface DelphiCalibrationInput {
  probability: number;
  outcome: 'YES' | 'NO';
  session: string;
  regime: string;
  strategyClass: string;
  horizon: string;
  symbol: string;
}

export interface ReliabilityBin {
  lowerBound: number;
  upperBound: number;
  count: number;
  avgConfidence: number;
  empiricalRate: number;
  confidenceBias: number;
}

export interface SegmentStats {
  key: string;
  resolvedCount: number;
  brierScore: number | null;
  accuracy: number | null;
  confidenceBias: number | null;
}

export interface DelphiCalibrationReport {
  resolvedCount: number;
  brierScore: number | null;
  accuracy: number | null;
  confidenceBias: number | null;
  reliabilityBins: ReliabilityBin[];
  segments: {
    session: SegmentStats[];
    regime: SegmentStats[];
    strategyClass: SegmentStats[];
    horizon: SegmentStats[];
    symbol: SegmentStats[];
  };
}

function toOutcomeValue(outcome: 'YES' | 'NO'): number {
  return outcome === 'YES' ? 1 : 0;
}

function normalizeTag(value: unknown): string {
  if (value === null || value === undefined) {
    return 'unknown';
  }
  const text = String(value).trim();
  return text.length > 0 ? text : 'unknown';
}

function computeAggregate(rows: DelphiCalibrationInput[]): {
  brierScore: number | null;
  accuracy: number | null;
  confidenceBias: number | null;
} {
  if (rows.length === 0) {
    return {
      brierScore: null,
      accuracy: null,
      confidenceBias: null,
    };
  }

  let brierSum = 0;
  let correct = 0;
  let confidenceSum = 0;
  let outcomeSum = 0;

  for (const row of rows) {
    const y = toOutcomeValue(row.outcome);
    brierSum += Math.pow(row.probability - y, 2);
    confidenceSum += row.probability;
    outcomeSum += y;
    const predictedOutcome: 'YES' | 'NO' = row.probability >= 0.5 ? 'YES' : 'NO';
    if (predictedOutcome === row.outcome) {
      correct += 1;
    }
  }

  const count = rows.length;
  const avgConfidence = confidenceSum / count;
  const empiricalRate = outcomeSum / count;

  return {
    brierScore: brierSum / count,
    accuracy: correct / count,
    confidenceBias: avgConfidence - empiricalRate,
  };
}

function computeReliabilityBins(
  rows: DelphiCalibrationInput[],
  bins: number
): ReliabilityBin[] {
  if (rows.length === 0 || bins <= 0) {
    return [];
  }

  const accumulators = Array.from({ length: bins }, () => ({
    count: 0,
    confidenceSum: 0,
    outcomeSum: 0,
  }));

  for (const row of rows) {
    const bounded = Math.min(1, Math.max(0, row.probability));
    const index = Math.min(Math.floor(bounded * bins), bins - 1);
    const bucket = accumulators[index];
    if (!bucket) {
      continue;
    }
    bucket.count += 1;
    bucket.confidenceSum += bounded;
    bucket.outcomeSum += toOutcomeValue(row.outcome);
  }

  const result: ReliabilityBin[] = [];
  for (let index = 0; index < bins; index += 1) {
    const bucket = accumulators[index];
    if (!bucket || bucket.count === 0) {
      continue;
    }
    const avgConfidence = bucket.confidenceSum / bucket.count;
    const empiricalRate = bucket.outcomeSum / bucket.count;
    result.push({
      lowerBound: index / bins,
      upperBound: (index + 1) / bins,
      count: bucket.count,
      avgConfidence,
      empiricalRate,
      confidenceBias: avgConfidence - empiricalRate,
    });
  }

  return result;
}

function computeSegmentStats(
  rows: DelphiCalibrationInput[],
  keySelector: (row: DelphiCalibrationInput) => string
): SegmentStats[] {
  const groups = new Map<string, DelphiCalibrationInput[]>();
  for (const row of rows) {
    const key = normalizeTag(keySelector(row));
    const entries = groups.get(key) ?? [];
    entries.push(row);
    groups.set(key, entries);
  }

  return Array.from(groups.entries())
    .map(([key, entries]) => {
      const aggregate = computeAggregate(entries);
      return {
        key,
        resolvedCount: entries.length,
        brierScore: aggregate.brierScore,
        accuracy: aggregate.accuracy,
        confidenceBias: aggregate.confidenceBias,
      };
    })
    .sort((a, b) => {
      if (b.resolvedCount !== a.resolvedCount) {
        return b.resolvedCount - a.resolvedCount;
      }
      return a.key.localeCompare(b.key);
    });
}

export function buildDelphiCalibrationReport(
  rows: DelphiCalibrationInput[],
  options?: { bins?: number }
): DelphiCalibrationReport {
  const bins = Math.max(1, Math.floor(options?.bins ?? 10));
  const aggregate = computeAggregate(rows);
  return {
    resolvedCount: rows.length,
    brierScore: aggregate.brierScore,
    accuracy: aggregate.accuracy,
    confidenceBias: aggregate.confidenceBias,
    reliabilityBins: computeReliabilityBins(rows, bins),
    segments: {
      session: computeSegmentStats(rows, (row) => row.session),
      regime: computeSegmentStats(rows, (row) => row.regime),
      strategyClass: computeSegmentStats(rows, (row) => row.strategyClass),
      horizon: computeSegmentStats(rows, (row) => row.horizon),
      symbol: computeSegmentStats(rows, (row) => row.symbol),
    },
  };
}

export function listResolvedDelphiCalibrationRows(
  limit?: number
): DelphiCalibrationInput[] {
  const db = openDatabase();
  const maxRows = Math.max(1, Math.floor(limit ?? 1000));

  const queryWithTags = `
    SELECT
      predicted_probability as probability,
      outcome,
      COALESCE(session_tag, 'unknown') as session,
      COALESCE(regime_tag, 'unknown') as regime,
      COALESCE(strategy_class, 'unknown') as strategyClass,
      COALESCE(CAST(horizon_minutes AS TEXT), 'unknown') as horizon,
      COALESCE(symbol, 'unknown') as symbol
    FROM predictions
    WHERE outcome IS NOT NULL
      AND predicted_probability IS NOT NULL
    ORDER BY outcome_timestamp DESC
    LIMIT ?
  `;

  const queryFallback = `
    SELECT
      predicted_probability as probability,
      outcome,
      'unknown' as session,
      'unknown' as regime,
      'unknown' as strategyClass,
      'unknown' as horizon,
      'unknown' as symbol
    FROM predictions
    WHERE outcome IS NOT NULL
      AND predicted_probability IS NOT NULL
    ORDER BY outcome_timestamp DESC
    LIMIT ?
  `;

  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(queryWithTags).all(maxRows) as Array<Record<string, unknown>>;
  } catch {
    rows = db.prepare(queryFallback).all(maxRows) as Array<Record<string, unknown>>;
  }

  return rows
    .filter(
      (row) =>
        typeof row.probability === 'number' &&
        (row.outcome === 'YES' || row.outcome === 'NO')
    )
    .map((row) => ({
      probability: Number(row.probability),
      outcome: row.outcome as 'YES' | 'NO',
      session: normalizeTag(row.session),
      regime: normalizeTag(row.regime),
      strategyClass: normalizeTag(row.strategyClass),
      horizon: normalizeTag(row.horizon),
      symbol: normalizeTag(row.symbol),
    }));
}

export function getDelphiCalibrationReport(options?: {
  bins?: number;
  limit?: number;
}): DelphiCalibrationReport {
  const rows = listResolvedDelphiCalibrationRows(options?.limit);
  return buildDelphiCalibrationReport(rows, { bins: options?.bins });
}
