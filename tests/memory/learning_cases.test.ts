import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPerpExecutionLearningCase, toPerpExecutionLearningCaseInput } from '../../src/core/perp_lifecycle.js';
import { recordOutcome } from '../../src/memory/calibration.js';
import { closeDatabase, openDatabase } from '../../src/memory/db.js';
import {
  countLearningCaseExclusions,
  createLearningCase,
  getLearningCaseById,
  listLearningCases,
  summarizeLearningTracks,
  updateLearningCaseOutcome,
} from '../../src/memory/learning_cases.js';
import { createPrediction } from '../../src/memory/predictions.js';

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
          WHERE name IN (
            'learning_cases',
            'comparable_learning_cases',
            'execution_learning_cases',
            'intervention_learning_cases',
            'regret_learning_cases'
          )
          ORDER BY name
        `
      )
      .all() as Array<{ name: string; type: string }>;

    expect(objects).toEqual([
      { name: 'comparable_learning_cases', type: 'view' },
      { name: 'execution_learning_cases', type: 'view' },
      { name: 'intervention_learning_cases', type: 'view' },
      { name: 'learning_cases', type: 'table' },
      { name: 'regret_learning_cases', type: 'view' },
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

    createLearningCase({
      id: 'case-intervention-1',
      caseType: 'intervention_quality',
      domain: 'perp',
      entityType: 'dossier',
      entityId: 'dossier-77',
      comparable: false,
      sourceTradeId: 77,
      sourceDossierId: 'dossier-77',
      sourceHypothesisId: 'hyp-77',
      context: { gateVerdict: 'resize' },
      outcome: { realizedPnlUsd: 1.4 },
      qualityScores: { gateInterventionQuality: 'strong' },
    });

    createLearningCase({
      id: 'case-regret-1',
      caseType: 'regret_case',
      domain: 'perp',
      entityType: 'symbol',
      entityId: 'BTC',
      comparable: false,
      sourceTradeId: 91,
      sourceHypothesisId: 'hyp-91',
      context: { missedTrade: true },
      outcome: { missedPnlUsd: 5.6 },
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
    expect(
      listLearningCases({
        caseType: 'intervention_quality',
        sourceHypothesisId: 'hyp-77',
      })
    ).toHaveLength(1);

    const summary = summarizeLearningTracks();
    expect(summary).toEqual({
      comparableForecastCases: 1,
      executionQualityCases: 1,
      thesisQualityCases: 0,
      interventionQualityCases: 1,
      regretCases: 1,
      comparableIncludedCases: 1,
      excludedComparableCases: 0,
      comparableByDomain: { prediction_market: 1 },
      executionByDomain: { perp: 1 },
      thesisByDomain: {},
      interventionByDomain: { perp: 1 },
      regretByDomain: { perp: 1 },
    });

    const viewCounts = db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM comparable_learning_cases) AS comparable_count,
            (SELECT COUNT(*) FROM execution_learning_cases) AS execution_count,
            (SELECT COUNT(*) FROM intervention_learning_cases) AS intervention_count,
            (SELECT COUNT(*) FROM regret_learning_cases) AS regret_count
        `
      )
      .get() as {
      comparable_count: number;
      execution_count: number;
      intervention_count: number;
      regret_count: number;
    };
    expect(viewCounts).toEqual({
      comparable_count: 1,
      execution_count: 1,
      intervention_count: 1,
      regret_count: 1,
    });
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

  it('syncs comparable forecast cases when a prediction resolves', () => {
    useTempDb('resolution-sync');
    const predictionId = createPrediction({
      marketId: 'poly:1',
      marketTitle: 'Test market',
      predictedOutcome: 'YES',
      predictedProbability: 0.7,
      modelProbability: 0.7,
      marketProbability: 0.58,
      domain: 'prediction_market',
      learningComparable: true,
    });

    createLearningCase({
      caseType: 'comparable_forecast',
      domain: 'prediction_market',
      entityType: 'market',
      entityId: 'poly:1',
      comparable: true,
      comparatorKind: 'market_price',
      sourcePredictionId: predictionId,
    });

    recordOutcome({ id: predictionId, outcome: 'NO', outcomeBasis: 'estimated', pnl: -4 });

    const learningCase = listLearningCases({
      caseType: 'comparable_forecast',
      sourcePredictionId: predictionId,
      limit: 1,
    })[0];

    expect(learningCase).toBeTruthy();
    expect(learningCase.comparable).toBe(false);
    expect(learningCase.exclusionReason).toBe('estimated_outcome_only');
    expect(learningCase.outcome?.outcome).toBe('NO');
    expect(learningCase.outcome?.outcomeBasis).toBe('estimated');
    expect(learningCase.outcome?.pnl).toBe(-4);
  });

  it('persists perp execution-quality cases', () => {
    useTempDb('execution-quality');
    const learningCase = buildPerpExecutionLearningCase({
      symbol: 'ETH',
      executionMode: 'paper',
      tradeId: 42,
      hypothesisId: 'eth_breakout',
      capturedAtMs: 1_700_000_000_000,
      side: 'sell',
      size: 2,
      leverage: 3,
      signalClass: 'momentum_breakout',
      marketRegime: 'trending',
      volatilityBucket: 'high',
      liquidityBucket: 'deep',
      tradeArchetype: 'intraday',
      entryTrigger: 'technical',
      expectedEdge: 0.08,
      invalidationPrice: 2550,
      timeStopAtMs: 1_700_000_360_000,
      entryPrice: 2500,
      exitPrice: 2450,
      pricePathHigh: 2520,
      pricePathLow: 2440,
      thesisCorrect: true,
      thesisInvalidationHit: false,
      exitMode: 'take_profit',
      realizedPnlUsd: 100,
      netRealizedPnlUsd: 96,
      realizedFeeUsd: 4,
      directionScore: 0.9,
      timingScore: 0.8,
      sizingScore: 0.7,
      exitScore: 0.85,
      capturedR: 1.5,
      leftOnTableR: 0.3,
      wouldHit2R: false,
      wouldHit3R: false,
      maeProxy: null,
      mfeProxy: null,
      reasoning: 'Breakout continuation',
      planContext: { source: 'test' },
      snapshot: { createdAtMs: 1_700_000_000_000, entryPrice: 2500, exitPrice: 2450 },
    });

    createLearningCase(toPerpExecutionLearningCaseInput(learningCase));

    const stored = listLearningCases({
      caseType: 'execution_quality',
      sourceTradeId: 42,
      limit: 1,
    })[0];

    expect(stored).toBeTruthy();
    expect(stored.entityId).toBe('ETH');
    expect(stored.comparable).toBe(false);
    expect(stored.exclusionReason).toBe('execution_quality_case');
    expect(stored.outcome?.thesisCorrect).toBe(true);
    expect(stored.qualityScores?.capturedR).toBe(1.5);
  });

  it('does not fabricate weight updates when signal scores are missing', () => {
    useTempDb('weight-updates');
    const predictionId = createPrediction({
      marketId: 'perp:SOL',
      marketTitle: 'SOL long',
      predictedOutcome: 'YES',
      predictedProbability: 0.66,
      modelProbability: 0.66,
      domain: 'perp',
      executed: true,
    });

    recordOutcome({ id: predictionId, outcome: 'YES', outcomeBasis: 'final', pnl: 5 });

    const db = openDatabase();
    const row = db.prepare('SELECT COUNT(*) AS c FROM weight_updates').get() as { c: number };
    expect(row.c).toBe(0);
  });
});
