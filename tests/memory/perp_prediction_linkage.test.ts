import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPrediction,
  findOpenPerpPrediction,
  findOpenPerpPredictionById,
} from '../../src/memory/predictions.js';
import {
  getPositionExitPolicy,
  upsertPositionExitPolicy,
} from '../../src/memory/position_exit_policy.js';

function useTempDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-perp-linkage-'));
  process.env.THUFIR_DB_PATH = join(dir, 'thufir.sqlite');
}

describe('perp prediction linkage', () => {
  beforeEach(() => {
    useTempDb();
  });

  it('stores predictionId on the active exit policy', () => {
    const predictionId = createPrediction({
      marketId: 'perp:BTC',
      marketTitle: 'BTC long',
      predictedOutcome: 'YES',
      predictedProbability: 0.71,
      modelProbability: 0.71,
      marketProbability: 0.5,
      symbol: 'BTC',
      domain: 'perp',
      learningComparable: true,
    });

    upsertPositionExitPolicy('BTC', 'long', 123_456, 61_000, 'notes', predictionId);

    const policy = getPositionExitPolicy('BTC');
    expect(policy?.predictionId).toBe(predictionId);
  });

  it('can recover the intended open prediction by id even when a newer same-symbol row exists', () => {
    const olderId = createPrediction({
      marketId: 'perp:ETH',
      marketTitle: 'ETH older thesis',
      predictedOutcome: 'YES',
      predictedProbability: 0.64,
      modelProbability: 0.64,
      marketProbability: 0.5,
      symbol: 'ETH',
      domain: 'perp',
      learningComparable: true,
      createdAt: '2026-04-24T10:00:00.000Z',
    });
    const newerId = createPrediction({
      marketId: 'perp:ETH',
      marketTitle: 'ETH newer thesis',
      predictedOutcome: 'NO',
      predictedProbability: 0.59,
      modelProbability: 0.59,
      marketProbability: 0.5,
      symbol: 'ETH',
      domain: 'perp',
      learningComparable: true,
      createdAt: '2026-04-24T11:00:00.000Z',
    });

    const latestBySymbol = findOpenPerpPrediction('ETH');
    const exactOlder = findOpenPerpPredictionById(olderId, 'ETH');
    const exactNewer = findOpenPerpPredictionById(newerId, 'ETH');

    expect(latestBySymbol?.id).toBe(newerId);
    expect(exactOlder?.id).toBe(olderId);
    expect(exactOlder?.predictedOutcome).toBe('YES');
    expect(exactNewer?.id).toBe(newerId);
    expect(exactNewer?.predictedOutcome).toBe('NO');
  });
});
