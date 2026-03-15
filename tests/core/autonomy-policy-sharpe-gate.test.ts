import { describe, expect, it, vi } from 'vitest';
import { summarizeSignalPerformance } from '../../src/core/signal_performance.js';
import type { PerpTradeJournalEntry } from '../../src/memory/perp_trade_journal.js';

function makeEntry(overrides: Partial<PerpTradeJournalEntry>): PerpTradeJournalEntry {
  return {
    id: 1,
    symbol: 'SOL',
    side: 'buy',
    size: 1,
    outcome: 'failed',
    signalClass: 'mean_reversion',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as PerpTradeJournalEntry;
}

describe('Sharpe gate resolved-only filtering', () => {
  it('unresolved failed entries yield sampleCount=0 when filtered before summarize', () => {
    // Simulate what evaluateGlobalTradeGate now does: pre-filter to resolved entries
    const rawEntries: PerpTradeJournalEntry[] = [
      makeEntry({ outcome: 'failed', thesisCorrect: undefined }),
      makeEntry({ outcome: 'failed', thesisCorrect: undefined }),
      makeEntry({ outcome: 'failed', thesisCorrect: undefined }),
      makeEntry({ outcome: 'executed', thesisCorrect: undefined }),
    ];

    const resolvedEntries = rawEntries.filter((e) => typeof e.thesisCorrect === 'boolean');
    const perf = summarizeSignalPerformance(resolvedEntries, 'mean_reversion');

    expect(perf.sampleCount).toBe(0);
    // With 0 samples, sharpeLike is 0 (not negative), so gate should not fire at default threshold
    expect(perf.sharpeLike).toBe(0);
  });

  it('resolved entries produce a meaningful sharpeLike', () => {
    const rawEntries: PerpTradeJournalEntry[] = [
      makeEntry({ outcome: 'executed', thesisCorrect: true }),
      makeEntry({ outcome: 'executed', thesisCorrect: true }),
      makeEntry({ outcome: 'executed', thesisCorrect: false }),
      makeEntry({ outcome: 'executed', thesisCorrect: false }),
      makeEntry({ outcome: 'executed', thesisCorrect: false }),
      // Unresolved — must not contribute
      makeEntry({ outcome: 'failed', thesisCorrect: undefined }),
      makeEntry({ outcome: 'failed', thesisCorrect: undefined }),
      makeEntry({ outcome: 'failed', thesisCorrect: undefined }),
    ];

    const resolvedEntries = rawEntries.filter((e) => typeof e.thesisCorrect === 'boolean');
    const perf = summarizeSignalPerformance(resolvedEntries, 'mean_reversion');

    expect(perf.sampleCount).toBe(5);
    // 2 wins (+1), 3 losses (-1) → expectancy negative → sharpeLike negative
    expect(perf.sharpeLike).toBeLessThan(0);
  });
});
