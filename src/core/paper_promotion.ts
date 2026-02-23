import type { PerpTradeJournalEntry } from '../memory/perp_trade_journal.js';

export type PaperPromotionGateConfig = {
  minTrades: number;
  maxDrawdownR: number;
  minHitRate: number;
  minPayoffRatio: number;
  minExpectancyR: number;
};

export type PaperPromotionReport = {
  setupKey: string;
  sampleCount: number;
  wins: number;
  losses: number;
  hitRate: number;
  payoffRatio: number;
  expectancyR: number;
  maxDrawdownR: number;
  gates: {
    minTrades: { required: number; actual: number; pass: boolean };
    maxDrawdownR: { maxAllowed: number; actual: number; pass: boolean };
    minHitRate: { required: number; actual: number; pass: boolean };
    minPayoffRatio: { required: number; actual: number; pass: boolean };
    minExpectancyR: { required: number; actual: number; pass: boolean };
  };
  promoted: boolean;
};

function toR(entry: PerpTradeJournalEntry): number | null {
  if (Number.isFinite(Number(entry.capturedR))) return Number(entry.capturedR);
  if (entry.thesisCorrect === true) return 1;
  if (entry.thesisCorrect === false) return -1;
  if (entry.outcome === 'failed') return -0.5;
  return null;
}

function maxDrawdownFromSeries(series: number[]): number {
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const value of series) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
  }
  return Math.abs(maxDd);
}

export function buildPaperPromotionReport(params: {
  entries: PerpTradeJournalEntry[];
  setupKey: string;
  gates: PaperPromotionGateConfig;
}): PaperPromotionReport {
  const filtered = params.entries.filter((entry) => {
    if (entry.outcome !== 'executed' && entry.outcome !== 'failed') return false;
    const key = `${entry.symbol}:${entry.signalClass ?? 'unknown'}`;
    return key === params.setupKey;
  });
  const scores = filtered.map(toR).filter((value): value is number => Number.isFinite(value));
  const wins = scores.filter((value) => value > 0).length;
  const losses = scores.filter((value) => value < 0).length;
  const sampleCount = scores.length;
  const hitRate = sampleCount > 0 ? wins / sampleCount : 0;
  const avgWin =
    wins > 0 ? scores.filter((value) => value > 0).reduce((sum, value) => sum + value, 0) / wins : 0;
  const avgLossAbs =
    losses > 0
      ? Math.abs(scores.filter((value) => value < 0).reduce((sum, value) => sum + value, 0) / losses)
      : 0;
  const payoffRatio = avgLossAbs > 0 ? avgWin / avgLossAbs : wins > 0 ? 99 : 0;
  const expectancyR = sampleCount > 0 ? scores.reduce((sum, value) => sum + value, 0) / sampleCount : 0;
  const maxDrawdownR = maxDrawdownFromSeries(scores);

  const gates = {
    minTrades: {
      required: params.gates.minTrades,
      actual: sampleCount,
      pass: sampleCount >= params.gates.minTrades,
    },
    maxDrawdownR: {
      maxAllowed: params.gates.maxDrawdownR,
      actual: maxDrawdownR,
      pass: maxDrawdownR <= params.gates.maxDrawdownR,
    },
    minHitRate: {
      required: params.gates.minHitRate,
      actual: hitRate,
      pass: hitRate >= params.gates.minHitRate,
    },
    minPayoffRatio: {
      required: params.gates.minPayoffRatio,
      actual: payoffRatio,
      pass: payoffRatio >= params.gates.minPayoffRatio,
    },
    minExpectancyR: {
      required: params.gates.minExpectancyR,
      actual: expectancyR,
      pass: expectancyR >= params.gates.minExpectancyR,
    },
  };

  const promoted = Object.values(gates).every((gate) => gate.pass);
  return {
    setupKey: params.setupKey,
    sampleCount,
    wins,
    losses,
    hitRate,
    payoffRatio,
    expectancyR,
    maxDrawdownR,
    gates,
    promoted,
  };
}
