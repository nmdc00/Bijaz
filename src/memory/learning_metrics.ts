import { openDatabase } from './db.js';

export type WindowMetrics = {
  windowSize: number;
  sampleCount: number;
  accuracy: number | null;
  brierModel: number | null;
  brierMarket: number | null;
  brierDelta: number | null;
  avgModelProbability: number | null;
  avgMarketProbability: number | null;
  avgEdge: number | null;
  totalPnl: number | null;
};

export const WINDOWS = [10, 20, 50, 100, 200] as const;
const MIN_BASELINE_SAMPLE = 20;

type LearningExampleRow = {
  outcome_value: number;
  brier_model: number;
  brier_market: number;
  model_probability: number;
  market_probability: number;
  pnl: number | null;
};

function emptyWindow(windowSize: number, sampleCount: number): WindowMetrics {
  return {
    windowSize,
    sampleCount,
    accuracy: null,
    brierModel: null,
    brierMarket: null,
    brierDelta: null,
    avgModelProbability: null,
    avgMarketProbability: null,
    avgEdge: null,
    totalPnl: null,
  };
}

function loadLearningRows(domain?: string): LearningExampleRow[] {
  const db = openDatabase();
  const sql = `
    SELECT
      outcome_value,
      brier_model,
      brier_market,
      model_probability,
      market_probability,
      pnl
    FROM learning_examples
    ${domain ? 'WHERE domain = ?' : ''}
    ORDER BY resolved_at DESC
    LIMIT 200
  `;
  return (domain ? db.prepare(sql).all(domain) : db.prepare(sql).all()) as LearningExampleRow[];
}

export function computeRollingWindowMetrics(domain?: string): WindowMetrics[] {
  const rows = loadLearningRows(domain);
  const totalAvailable = rows.length;

  return WINDOWS.map((windowSize) => {
    const slice = rows.slice(0, windowSize);
    const sampleCount = slice.length;
    if (totalAvailable < MIN_BASELINE_SAMPLE || sampleCount < windowSize) {
      return emptyWindow(windowSize, sampleCount);
    }

    let correct = 0;
    let brierModelSum = 0;
    let brierMarketSum = 0;
    let modelProbSum = 0;
    let marketProbSum = 0;
    let edgeSum = 0;
    let pnlSum = 0;

    for (const row of slice) {
      const predictedOutcome = row.model_probability >= 0.5 ? 1 : 0;
      if (predictedOutcome === row.outcome_value) {
        correct += 1;
      }
      brierModelSum += row.brier_model;
      brierMarketSum += row.brier_market;
      modelProbSum += row.model_probability;
      marketProbSum += row.market_probability;
      edgeSum += row.model_probability - row.market_probability;
      pnlSum += row.pnl ?? 0;
    }

    const n = sampleCount;
    const brierModel = brierModelSum / n;
    const brierMarket = brierMarketSum / n;

    return {
      windowSize,
      sampleCount,
      accuracy: correct / n,
      brierModel,
      brierMarket,
      brierDelta: brierMarket - brierModel,
      avgModelProbability: modelProbSum / n,
      avgMarketProbability: marketProbSum / n,
      avgEdge: edgeSum / n,
      totalPnl: pnlSum,
    };
  });
}

export function computeDomainWindowMetrics(): Record<string, WindowMetrics[]> {
  const db = openDatabase();
  const rows = db.prepare(
    `SELECT DISTINCT domain FROM learning_examples WHERE domain IS NOT NULL ORDER BY domain ASC`
  ).all() as Array<{ domain?: string | null }>;

  const result: Record<string, WindowMetrics[]> = {};
  for (const row of rows) {
    const domain = String(row.domain ?? '').trim();
    if (!domain) {
      continue;
    }
    result[domain] = computeRollingWindowMetrics(domain);
  }
  return result;
}
