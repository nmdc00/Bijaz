import { describe, expect, it } from 'vitest';

import {
  summarizeAllSignalClasses,
  summarizeSignalPerformance,
} from '../../src/core/signal_performance.js';

describe('signal_performance', () => {
  it('summarizes per-signal expectancy and sharpe-like score', () => {
    const entries = [
      { kind: 'perp_trade_journal', outcome: 'executed', signalClass: 'mean_reversion', thesisCorrect: true },
      { kind: 'perp_trade_journal', outcome: 'executed', signalClass: 'mean_reversion', thesisCorrect: false },
      { kind: 'perp_trade_journal', outcome: 'failed', signalClass: 'mean_reversion', thesisCorrect: false },
      { kind: 'perp_trade_journal', outcome: 'executed', signalClass: 'momentum_breakout', thesisCorrect: true },
    ] as any;

    const mr = summarizeSignalPerformance(entries, 'mean_reversion');
    expect(mr.sampleCount).toBe(3);
    expect(mr.wins).toBe(1);
    expect(mr.losses).toBe(2);
    expect(Number.isFinite(mr.expectancy)).toBe(true);
  });

  it('builds summary map for all populated signal classes', () => {
    const entries = [
      { kind: 'perp_trade_journal', outcome: 'executed', signalClass: 'mean_reversion', thesisCorrect: true },
      { kind: 'perp_trade_journal', outcome: 'executed', signalClass: 'momentum_breakout', thesisCorrect: true },
    ] as any;

    const map = summarizeAllSignalClasses(entries);
    expect(Object.keys(map)).toContain('mean_reversion');
    expect(Object.keys(map)).toContain('momentum_breakout');
  });
});
