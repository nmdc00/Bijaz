import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPerpExecutionLearningCase, toPerpExecutionLearningCaseInput } from '../../src/core/perp_lifecycle.js';
import { computePerpInterventionEvidence } from '../../src/core/thesis_learning.js';
import { closeDatabase } from '../../src/memory/db.js';
import { createLearningCase, listLearningCases } from '../../src/memory/learning_cases.js';

const previousDbPath = process.env.THUFIR_DB_PATH;
let currentDbPath: string | null = null;
let currentDbDir: string | null = null;

function useTempDb(name: string): string {
  currentDbDir = mkdtempSync(join(tmpdir(), `thufir-perp-learning-${name}-`));
  currentDbPath = join(currentDbDir, 'thufir.sqlite');
  process.env.THUFIR_DB_PATH = currentDbPath;
  return currentDbPath;
}

afterEach(() => {
  if (currentDbPath) {
    closeDatabase(currentDbPath);
  }
  process.env.THUFIR_DB_PATH = previousDbPath;
  if (currentDbDir) {
    rmSync(currentDbDir, { recursive: true, force: true });
  }
  currentDbPath = null;
  currentDbDir = null;
});

describe('perp learning scoring v2.1', () => {
  it('computes deterministic counterfactual evidence for resize and leverage cap interventions', () => {
    const evidence = computePerpInterventionEvidence({
      requestedSize: 10,
      approvedSize: 6,
      requestedLeverage: 3,
      approvedLeverage: 1,
      netRealizedPnlUsd: -12,
      realizedFeeUsd: 1,
      gateVerdict: 'resize',
    });

    expect(evidence).toEqual({
      gateVerdict: 'resize',
      requestedSize: 10,
      approvedSize: 6,
      requestedLeverage: 3,
      approvedLeverage: 1,
      sizeFillRatio: 0.6,
      leverageFillRatio: 1 / 3,
      fullRequestSizeCounterfactualNetPnlUsd: -20,
      rejectBaselineNetPnlUsd: 0,
      resizeValueAddUsd: 8,
      leverageCapValueAddUsd: 24,
      interventionScore: expect.any(Number),
    });
    expect(evidence?.interventionScore).toBeGreaterThan(0);
  });

  it('persists paired thesis and execution learning cases with divergent scores', () => {
    useTempDb('paired-cases');
    const executionCase = buildPerpExecutionLearningCase({
      symbol: 'XYZ:COIN',
      executionMode: 'paper',
      tradeId: 901,
      dossierId: 'dossier-901',
      hypothesisId: 'coin-breakout',
      capturedAtMs: 1_700_000_000_000,
      side: 'buy',
      size: 6,
      leverage: 1,
      signalClass: 'momentum_breakout',
      marketRegime: 'unknown',
      volatilityBucket: 'high',
      liquidityBucket: 'deep',
      tradeArchetype: 'swing',
      entryTrigger: 'hybrid',
      expectedEdge: 0.72,
      invalidationPrice: 214,
      timeStopAtMs: 1_700_000_360_000,
      entryPrice: 220.7,
      exitPrice: 219.4,
      pricePathHigh: 228.2,
      pricePathLow: 213.8,
      thesisCorrect: true,
      thesisInvalidationHit: false,
      exitMode: 'manual',
      realizedPnlUsd: -4,
      netRealizedPnlUsd: -6,
      realizedFeeUsd: 2,
      directionScore: 0.82,
      timingScore: 0.21,
      sizingScore: 0.78,
      exitScore: 0.18,
      capturedR: -0.2,
      leftOnTableR: 1.4,
      wouldHit2R: false,
      wouldHit3R: false,
      maeProxy: 0.8,
      mfeProxy: 0.9,
      reasoning: 'Crypto-beta continuation after event impulse.',
      planContext: { catalystFreshness: 'fresh', gate: 'resize' },
      snapshot: { createdAtMs: 1_700_000_000_000, setup: 'stretched_breakout' },
      requestedSize: 10,
      approvedSize: 6,
      requestedLeverage: 3,
      approvedLeverage: 1,
      gateVerdict: 'resize',
      gateReasonCode: 'stretched_entry',
    });

    createLearningCase(toPerpExecutionLearningCaseInput(executionCase));

    const stored = listLearningCases({
      sourceTradeId: 901,
      entityId: 'XYZ:COIN',
      limit: 10,
    });

    expect(stored).toHaveLength(2);
    const executionStored = stored.find((row) => row.caseType === 'execution_quality');
    const thesisStored = stored.find((row) => row.caseType === 'thesis_quality');

    expect(executionStored).toBeTruthy();
    expect(thesisStored).toBeTruthy();
    expect(executionStored?.qualityScores?.compositeScore).toBeLessThan(0.6);
    expect(thesisStored?.qualityScores?.thesisCompositeScore).toBeGreaterThan(0.75);
    expect(thesisStored?.policyInputs?.interventionEvidence).toMatchObject({
      gateVerdict: 'resize',
      requestedSize: 10,
      approvedSize: 6,
      resizeValueAddUsd: 4,
      leverageCapValueAddUsd: 12,
    });
    expect(executionStored?.policyInputs?.gateVerdict).toBe('resize');
  });
});
