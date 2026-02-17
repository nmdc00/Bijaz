import { describe, expect, it } from 'vitest';

import { computeClosedTradeComponentScores } from '../../src/core/decision_component_scores.js';

describe('decision component scores', () => {
  it('scores long closed trades deterministically', () => {
    const result = computeClosedTradeComponentScores({
      entrySide: 'buy',
      thesisCorrect: true,
      size: 0.4,
      expectedEdge: 0.6,
      entryPrice: 100,
      exitPrice: 110,
      pricePathHigh: 120,
      pricePathLow: 90,
    });

    expect(result.directionScore).toBe(1);
    expect(result.timingScore).toBeCloseTo(2 / 3, 8);
    expect(result.sizingScore).toBeCloseTo(0.6857142857, 8);
    expect(result.exitScore).toBeCloseTo(0.5, 8);
  });

  it('scores short closed trades deterministically', () => {
    const result = computeClosedTradeComponentScores({
      entrySide: 'sell',
      thesisCorrect: false,
      size: 2,
      expectedEdge: 0.2,
      entryPrice: 100,
      exitPrice: 105,
      pricePathHigh: 110,
      pricePathLow: 80,
    });

    expect(result.directionScore).toBe(0);
    expect(result.timingScore).toBeCloseTo(2 / 3, 8);
    expect(result.sizingScore).toBeCloseTo(0.5333333333, 8);
    expect(result.exitScore).toBe(0);
  });

  it('falls back to neutral scores when inputs are missing', () => {
    const result = computeClosedTradeComponentScores({
      entrySide: 'buy',
      thesisCorrect: null,
    });

    expect(result.directionScore).toBe(0.5);
    expect(result.timingScore).toBe(0.5);
    expect(result.sizingScore).toBe(0.5);
    expect(result.exitScore).toBe(0.5);
  });
});
