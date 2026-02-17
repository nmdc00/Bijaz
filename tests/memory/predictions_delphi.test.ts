import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPrediction,
  getPrediction,
  listDuePredictionsForResolution,
} from '../../src/memory/predictions.js';

function useTempDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-delphi-predictions-'));
  process.env.THUFIR_DB_PATH = join(dir, 'thufir.sqlite');
}

describe('delphi prediction storage', () => {
  beforeEach(() => {
    useTempDb();
  });

  it('persists confidence, horizon, and context tags', () => {
    const id = createPrediction({
      marketId: 'm-delphi-1',
      marketTitle: 'Will market drift up over the next 3h?',
      predictedOutcome: 'YES',
      predictedProbability: 0.67,
      confidenceLevel: 'high',
      confidenceRaw: 0.74,
      confidenceAdjusted: 0.69,
      domain: 'macro',
      horizonMinutes: 180,
      contextTags: ['session:london', 'liquidity:normal'],
      createdAt: '2026-02-17T00:00:00.000Z',
    });

    const prediction = getPrediction(id);
    expect(prediction).not.toBeNull();
    expect(prediction?.confidenceLevel).toBe('high');
    expect(prediction?.confidenceRaw).toBeCloseTo(0.74, 6);
    expect(prediction?.confidenceAdjusted).toBeCloseTo(0.69, 6);
    expect(prediction?.horizonMinutes).toBe(180);
    expect(prediction?.expiresAt).toBe('2026-02-17T03:00:00.000Z');
    expect(prediction?.contextTags).toEqual(['session:london', 'liquidity:normal']);
    expect(prediction?.resolutionStatus).toBe('open');
  });

  it('selects only predictions due by horizon cutoff', () => {
    createPrediction({
      marketId: 'm-delphi-due',
      marketTitle: 'Due prediction',
      predictedOutcome: 'YES',
      horizonMinutes: 60,
      createdAt: '2026-02-17T00:00:00.000Z',
    });
    createPrediction({
      marketId: 'm-delphi-future',
      marketTitle: 'Future prediction',
      predictedOutcome: 'NO',
      horizonMinutes: 120,
      createdAt: '2026-02-17T00:30:00.000Z',
    });

    const due = listDuePredictionsForResolution('2026-02-17T01:15:00.000Z', 10);
    expect(due).toHaveLength(1);
    expect(due[0]?.marketId).toBe('m-delphi-due');
  });
});
