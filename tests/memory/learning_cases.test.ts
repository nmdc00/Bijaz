import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/memory/db.js';
import {
  countLearningCaseExclusions,
  createLearningCase,
  getLearningCaseById,
  listLearningCases,
  summarizeLearningTracks,
  updateLearningCaseOutcome,
} from '../../src/memory/learning_cases.js';

const previousDbPath = process.env.THUFIR_DB_PATH;
let currentDbPath: string | null = null;
let currentDbDir: string | null = null;

function useTempDb(name: string): string {
  currentDbDir = mkdtempSync(join(tmpdir(), `thufir-learning-cases-${name}-`));
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

describe('learning_cases memory', () => {
  it('creates learning-case table and views when opening a legacy db', () => {
    const dbPath = useTempDb('migration');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE predictions (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        market_title TEXT NOT NULL,
        predicted_outcome TEXT,
        predicted_probability REAL
      )
    `);
    legacy.close();

    const db = openDatabase(dbPath);
    const objects = db
      .prepare(
        `
          SELECT name, type
          FROM sqlite_master
          WHERE name IN ('learning_cases', 'comparable_learning_cases', 'execution_learning_cases')
          ORDER BY name
        `
      )
      .all() as Array<{ name: string; type: string }>;

    expect(objects).toEqual([
      { name: 'comparable_learning_cases', type: 'view' },
      { name: 'execution_learning_cases', type: 'view' },
      { name: 'learning_cases', type: 'table' },
    ]);
  });

  it('stores, updates, lists, and summarizes canonical learning cases', () => {
    const dbPath = useTempDb('crud');
    const db = openDatabase(dbPath);

    const comparableCase = createLearningCase({
      id: 'case-forecast-1',
      caseType: 'comparable_forecast',
      domain: 'prediction_market',
      entityType: 'market',
      entityId: 'market-123',
      comparable: true,
      comparatorKind: 'market_price',
      sourcePredictionId: 'pred-123',
      belief: { modelProbability: 0.67, predictedOutcome: 'YES' },
      baseline: { marketProbability: 0.54 },
      context: { horizonMinutes: 90, regime: 'trend' },
      action: { executed: true, positionSize: 15 },
      policyInputs: { gate: 'plil' },
    });

    const executionCase = createLearningCase({
      id: 'case-exec-1',
      caseType: 'execution_quality',
      domain: 'perp',
      entityType: 'symbol',
      entityId: 'BTC',
      comparable: false,
      exclusionReason: 'missing_comparator',
      sourceTradeId: 77,
      sourceArtifactId: 88,
      context: {
        signalClass: 'breakout_15m',
        marketRegime: 'trend',
        volatilityBucket: 'high',
      },
      action: { side: 'short', entryPrice: 81010.97, size: 0.0015 },
      outcome: { realizedPnlUsd: -0.68 },
      qualityScores: { directionQuality: 0.2, timingQuality: 0.1, capturedR: -0.05 },
      policyInputs: { policyTrack: 'execution_quality' },
    });

    const updatedExecutionCase = updateLearningCaseOutcome({
      id: executionCase.id,
      outcome: { realizedPnlUsd: 12.5, thesisCorrect: true },
      qualityScores: { directionQuality: 0.8, timingQuality: 0.7, capturedR: 1.1 },
      policyInputs: { sizeMultiplier: 0.8, sourceTrack: 'execution_quality' },
    });

    expect(comparableCase.sourcePredictionId).toBe('pred-123');
    expect(updatedExecutionCase.updatedAt).not.toBeNull();
    expect(updatedExecutionCase.outcome).toEqual({
      realizedPnlUsd: 12.5,
      thesisCorrect: true,
    });
    expect(updatedExecutionCase.qualityScores).toEqual({
      directionQuality: 0.8,
      timingQuality: 0.7,
      capturedR: 1.1,
    });

    expect(getLearningCaseById('case-exec-1').sourceTradeId).toBe(77);

    const executionRows = listLearningCases({
      caseType: 'execution_quality',
      domain: 'perp',
      sourceTradeId: 77,
    });
    expect(executionRows).toHaveLength(1);
    expect(executionRows[0]?.entityId).toBe('BTC');

    const summary = summarizeLearningTracks();
    expect(summary).toEqual({
      comparableForecastCases: 1,
      executionQualityCases: 1,
      comparableIncludedCases: 1,
      excludedComparableCases: 0,
      comparableByDomain: { prediction_market: 1 },
      executionByDomain: { perp: 1 },
    });

    const viewCounts = db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM comparable_learning_cases) AS comparable_count,
            (SELECT COUNT(*) FROM execution_learning_cases) AS execution_count
        `
      )
      .get() as { comparable_count: number; execution_count: number };
    expect(viewCounts).toEqual({ comparable_count: 1, execution_count: 1 });
  });

  it('aggregates exclusion reasons for non-comparable learning cases', () => {
    useTempDb('exclusions');
    createLearningCase({
      caseType: 'comparable_forecast',
      domain: 'perp',
      entityType: 'symbol',
      entityId: 'ETH',
      comparable: false,
      exclusionReason: 'missing_comparator',
      belief: { modelProbability: 0.61 },
    });
    createLearningCase({
      caseType: 'execution_quality',
      domain: 'perp',
      entityType: 'symbol',
      entityId: 'SOL',
      comparable: false,
      exclusionReason: 'missing_comparator',
      action: { side: 'short' },
    });
    createLearningCase({
      caseType: 'comparable_forecast',
      domain: 'macro',
      entityType: 'event',
      entityId: 'cpi',
      comparable: false,
      exclusionReason: 'estimated_outcome_only',
      belief: { modelProbability: 0.58 },
    });

    expect(countLearningCaseExclusions()).toEqual([
      { exclusionReason: 'missing_comparator', count: 2 },
      { exclusionReason: 'estimated_outcome_only', count: 1 },
    ]);
  });
});
