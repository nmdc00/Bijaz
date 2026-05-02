import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordOutcome } from '../../src/memory/calibration.js';
import {
  computeDomainWindowMetrics,
  computeRollingWindowMetrics,
} from '../../src/memory/learning_metrics.js';
import { createPrediction } from '../../src/memory/predictions.js';

function useTempDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-learning-metrics-'));
  process.env.THUFIR_DB_PATH = join(dir, 'thufir.sqlite');
}

function seedComparablePredictions(count: number, domain = 'binary'): void {
  for (let index = 0; index < count; index += 1) {
    const id = createPrediction({
      marketId: `market-${domain}-${index}`,
      marketTitle: `Market ${index}`,
      predictedOutcome: 'YES',
      predictedProbability: 0.65,
      modelProbability: 0.65,
      marketProbability: 0.55,
      domain,
      executed: true,
    });
    recordOutcome({
      id,
      outcome: index % 4 === 0 ? 'NO' : 'YES',
      outcomeBasis: 'final',
      pnl: index % 4 === 0 ? -5 : 8,
    });
  }
}

describe('learning_metrics', () => {
  beforeEach(() => {
    useTempDb();
  });

  it('returns null metrics for all windows when fewer than 20 final examples exist', () => {
    seedComparablePredictions(15);

    const metrics = computeRollingWindowMetrics();

    expect(metrics).toHaveLength(5);
    expect(metrics.every((window) => window.accuracy === null)).toBe(true);
  });

  it('populates 10 and 20 windows when at least 20 examples exist', () => {
    seedComparablePredictions(25);

    const metrics = computeRollingWindowMetrics();
    const w10 = metrics.find((window) => window.windowSize === 10);
    const w20 = metrics.find((window) => window.windowSize === 20);
    const w50 = metrics.find((window) => window.windowSize === 50);

    expect(w10?.accuracy).not.toBeNull();
    expect(w20?.accuracy).not.toBeNull();
    expect(w50?.accuracy).toBeNull();
  });

  it('computes positive brier delta when model beats market baseline', () => {
    seedComparablePredictions(20, 'crypto');

    const metrics = computeRollingWindowMetrics('crypto');
    const w20 = metrics.find((window) => window.windowSize === 20);

    expect(w20?.brierDelta).not.toBeNull();
    expect(Number(w20?.brierDelta)).toBeGreaterThan(0);
  });

  it('groups metrics by domain', () => {
    seedComparablePredictions(20, 'binary');
    seedComparablePredictions(20, 'macro');

    const byDomain = computeDomainWindowMetrics();

    expect(Object.keys(byDomain)).toEqual(['binary', 'macro']);
    expect(byDomain.binary?.find((window) => window.windowSize === 20)?.accuracy).not.toBeNull();
    expect(byDomain.macro?.find((window) => window.windowSize === 20)?.accuracy).not.toBeNull();
  });
});
