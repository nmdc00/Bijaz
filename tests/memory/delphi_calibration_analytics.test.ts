import { describe, expect, it } from 'vitest';

import { buildDelphiCalibrationReport, type DelphiCalibrationInput } from '../../src/memory/calibration_analytics.js';

describe('delphi calibration analytics', () => {
  it('computes brier score, reliability bins, confidence bias, and segments', () => {
    const rows: DelphiCalibrationInput[] = [
      {
        probability: 0.8,
        outcome: 'YES',
        session: 'us',
        regime: 'trend',
        strategyClass: 'breakout',
        horizon: '60',
        symbol: 'BTC',
      },
      {
        probability: 0.6,
        outcome: 'NO',
        session: 'us',
        regime: 'trend',
        strategyClass: 'mean_reversion',
        horizon: '60',
        symbol: 'BTC',
      },
      {
        probability: 0.3,
        outcome: 'YES',
        session: 'asia',
        regime: 'range',
        strategyClass: 'breakout',
        horizon: '240',
        symbol: 'ETH',
      },
      {
        probability: 0.2,
        outcome: 'NO',
        session: 'asia',
        regime: 'range',
        strategyClass: 'breakout',
        horizon: '240',
        symbol: 'SOL',
      },
    ];

    const report = buildDelphiCalibrationReport(rows, { bins: 5 });

    expect(report.resolvedCount).toBe(4);
    expect(report.brierScore).toBeCloseTo(0.2325, 10);
    expect(report.accuracy).toBeCloseTo(0.5, 10);
    expect(report.confidenceBias).toBeCloseTo(-0.025, 10);

    expect(report.reliabilityBins).toHaveLength(3);
    expect(report.reliabilityBins[0]).toMatchObject({
      lowerBound: 0.2,
      upperBound: 0.4,
      count: 2,
    });
    expect(report.reliabilityBins[0].avgConfidence).toBeCloseTo(0.25, 10);
    expect(report.reliabilityBins[0].empiricalRate).toBeCloseTo(0.5, 10);
    expect(report.reliabilityBins[0].confidenceBias).toBeCloseTo(-0.25, 10);

    const us = report.segments.session.find((row) => row.key === 'us');
    expect(us).toBeDefined();
    expect(us?.resolvedCount).toBe(2);
    expect(us?.brierScore).toBeCloseTo(0.2, 10);
    expect(us?.accuracy).toBeCloseTo(0.5, 10);
    expect(us?.confidenceBias).toBeCloseTo(0.2, 10);

    const btc = report.segments.symbol.find((row) => row.key === 'BTC');
    expect(btc).toBeDefined();
    expect(btc?.resolvedCount).toBe(2);
    expect(btc?.brierScore).toBeCloseTo(0.2, 10);
  });

  it('handles at least 100 resolved synthetic predictions', () => {
    const rows: DelphiCalibrationInput[] = [];
    for (let index = 0; index < 100; index += 1) {
      const probability = (index % 10) / 10 + 0.05;
      rows.push({
        probability: Math.min(0.99, probability),
        outcome: index % 2 === 0 ? 'YES' : 'NO',
        session: index % 3 === 0 ? 'us' : index % 3 === 1 ? 'asia' : 'eu',
        regime: index % 2 === 0 ? 'trend' : 'range',
        strategyClass: index % 4 < 2 ? 'breakout' : 'mean_reversion',
        horizon: index % 2 === 0 ? '60' : '240',
        symbol: index % 5 === 0 ? 'BTC' : 'ETH',
      });
    }

    const report = buildDelphiCalibrationReport(rows, { bins: 10 });
    expect(report.resolvedCount).toBe(100);
    expect(report.brierScore).not.toBeNull();
    expect(report.reliabilityBins.length).toBeGreaterThan(0);
    expect(report.segments.session.length).toBeGreaterThan(0);
    expect(report.segments.regime.length).toBeGreaterThan(0);
    expect(report.segments.strategyClass.length).toBeGreaterThan(0);
    expect(report.segments.horizon.length).toBeGreaterThan(0);
    expect(report.segments.symbol.length).toBeGreaterThan(0);
  });
});
