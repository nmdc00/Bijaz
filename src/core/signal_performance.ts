import type { PerpTradeJournalEntry } from '../memory/perp_trade_journal.js';

export type SignalPerformanceSummary = {
  signalClass: string;
  sampleCount: number;
  wins: number;
  losses: number;
  thesisCorrectRate: number;
  expectancy: number;
  variance: number;
  sharpeLike: number;
  maeProxy: number;
  mfeProxy: number;
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function variance(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  return mean(values.map((value) => (value - m) ** 2));
}

export function summarizeSignalPerformance(
  entries: PerpTradeJournalEntry[],
  signalClass: string
): SignalPerformanceSummary {
  const scoped = entries.filter((entry) => {
    const entryClass = typeof entry.signalClass === 'string' ? entry.signalClass : null;
    return entryClass === signalClass;
  });

  const outcomes = scoped
    .map((entry) => {
      if (entry.thesisCorrect === true) return 1;
      if (entry.thesisCorrect === false) return -1;
      return entry.outcome === 'failed' ? -0.5 : entry.outcome === 'executed' ? 0.25 : 0;
    })
    .filter((score) => Number.isFinite(score));

  const wins = scoped.filter((entry) => entry.thesisCorrect === true).length;
  const losses = scoped.filter((entry) => entry.thesisCorrect === false).length;
  const sampleCount = scoped.length;
  const expectancy = mean(outcomes);
  const varScore = variance(outcomes);
  const stdScore = Math.sqrt(Math.max(varScore, 1e-9));
  const sharpeLike = outcomes.length >= 2 ? expectancy / stdScore : 0;

  const adverseMoves = scoped
    .map((entry) => Number(entry.maeProxy ?? NaN))
    .filter((value) => Number.isFinite(value));
  const favorableMoves = scoped
    .map((entry) => Number(entry.mfeProxy ?? NaN))
    .filter((value) => Number.isFinite(value));

  return {
    signalClass,
    sampleCount,
    wins,
    losses,
    thesisCorrectRate:
      sampleCount > 0
        ? scoped.filter((entry) => entry.thesisCorrect === true).length / sampleCount
        : 0,
    expectancy,
    variance: varScore,
    sharpeLike,
    maeProxy: mean(adverseMoves),
    mfeProxy: mean(favorableMoves),
  };
}

export function summarizeAllSignalClasses(
  entries: PerpTradeJournalEntry[]
): Record<string, SignalPerformanceSummary> {
  const classes = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.signalClass === 'string' && entry.signalClass.trim().length > 0) {
      classes.add(entry.signalClass);
    }
  }

  const out: Record<string, SignalPerformanceSummary> = {};
  for (const signalClass of classes) {
    out[signalClass] = summarizeSignalPerformance(entries, signalClass);
  }
  return out;
}
