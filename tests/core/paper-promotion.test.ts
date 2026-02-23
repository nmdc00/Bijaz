import { describe, expect, it } from 'vitest';

import { buildPaperPromotionReport } from '../../src/core/paper_promotion.js';

describe('paper promotion gates', () => {
  it('passes setup when all mechanical gates are met', () => {
    const report = buildPaperPromotionReport({
      setupKey: 'BTC:breakout_15m',
      gates: {
        minTrades: 4,
        maxDrawdownR: 3,
        minHitRate: 0.5,
        minPayoffRatio: 1.1,
        minExpectancyR: 0.1,
      },
      entries: [
        { kind: 'perp_trade_journal', symbol: 'BTC', signalClass: 'breakout_15m', outcome: 'executed', capturedR: 1.5 },
        { kind: 'perp_trade_journal', symbol: 'BTC', signalClass: 'breakout_15m', outcome: 'executed', capturedR: 0.8 },
        { kind: 'perp_trade_journal', symbol: 'BTC', signalClass: 'breakout_15m', outcome: 'executed', capturedR: -0.6 },
        { kind: 'perp_trade_journal', symbol: 'BTC', signalClass: 'breakout_15m', outcome: 'failed', capturedR: -0.4 },
      ] as any,
    });

    expect(report.sampleCount).toBe(4);
    expect(report.promoted).toBe(true);
    expect(report.gates.minTrades.pass).toBe(true);
    expect(report.gates.maxDrawdownR.pass).toBe(true);
    expect(report.gates.minHitRate.pass).toBe(true);
  });

  it('fails setup when drawdown or sample gates fail', () => {
    const report = buildPaperPromotionReport({
      setupKey: 'ETH:mean_reversion_5m',
      gates: {
        minTrades: 5,
        maxDrawdownR: 1,
        minHitRate: 0.4,
        minPayoffRatio: 1,
        minExpectancyR: 0,
      },
      entries: [
        { kind: 'perp_trade_journal', symbol: 'ETH', signalClass: 'mean_reversion_5m', outcome: 'executed', capturedR: -0.9 },
        { kind: 'perp_trade_journal', symbol: 'ETH', signalClass: 'mean_reversion_5m', outcome: 'executed', capturedR: -0.7 },
        { kind: 'perp_trade_journal', symbol: 'ETH', signalClass: 'mean_reversion_5m', outcome: 'executed', capturedR: 0.5 },
      ] as any,
    });

    expect(report.promoted).toBe(false);
    expect(report.gates.minTrades.pass).toBe(false);
    expect(report.gates.maxDrawdownR.pass).toBe(false);
  });
});
