import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createPrediction, getPrediction } from '../../src/memory/predictions.js';
import { countFinalPredictions, recordOutcome } from '../../src/memory/calibration.js';
import { openDatabase } from '../../src/memory/db.js';
import { getSignalWeights } from '../../src/memory/learning.js';

function useTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-plil-'));
  const path = join(dir, 'thufir.sqlite');
  process.env.THUFIR_DB_PATH = path;
  return path;
}

describe('PLIL predictions — data integrity', () => {
  beforeEach(() => {
    useTempDb();
  });

  it('migration handles legacy predictions table without predicted_outcome column', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'thufir-legacy-')), 'thufir.sqlite');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE predictions (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        market_title TEXT NOT NULL
      )
    `);
    raw.exec(`INSERT INTO predictions VALUES ('test-1', 'm1', 'Title 1')`);
    raw.close();

    process.env.THUFIR_DB_PATH = dbPath;
    // Must not throw even though predicted_outcome column is absent
    expect(() => openDatabase()).not.toThrow();

    const db = openDatabase();
    const cols = db.prepare("PRAGMA table_info('predictions')").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('model_probability')).toBe(true);
    expect(names.has('market_probability')).toBe(true);
    expect(names.has('learning_comparable')).toBe(true);
    expect(names.has('outcome_basis')).toBe(true);

    // Existing row survived with correct defaults
    const row = db.prepare("SELECT * FROM predictions WHERE id = 'test-1'").get() as any;
    expect(row.learning_comparable).toBe(0);
    expect(row.outcome_basis).toBe('legacy');
  });

  it('synthetic perp prediction is never marked learning-comparable', () => {
    const id = createPrediction({
      marketId: 'perp:SOL',
      marketTitle: 'SOL long: breakout thesis',
      predictedOutcome: 'YES',
      predictedProbability: 0.74,
      modelProbability: 0.74,
      marketProbability: 0.5,
      symbol: 'SOL',
      domain: 'perp',
      learningComparable: true,
      horizonMinutes: 90,
      executed: true,
      executionPrice: 150.5,
      positionSize: 0.667,
    });

    const pred = getPrediction(id);
    expect(pred).not.toBeNull();
    expect(pred!.modelProbability).toBeCloseTo(0.74, 6);
    expect(pred!.marketProbability).toBeCloseTo(0.5, 6);
    expect(pred!.learningComparable).toBe(false);
    expect(pred!.executed).toBe(true);
    expect(pred!.executionPrice).toBeCloseTo(150.5, 4);
    expect(pred!.positionSize).toBeCloseTo(0.667, 4);
    expect(pred!.outcomeBasis).toBe('legacy');
    expect(pred!.resolutionStatus).toBe('open');
  });

  it('keeps comparable rows when perp predictions carry a real comparator', () => {
    const id = createPrediction({
      marketId: 'perp:SOL',
      marketTitle: 'SOL long: real comparator thesis',
      predictedOutcome: 'YES',
      predictedProbability: 0.74,
      modelProbability: 0.74,
      marketProbability: 0.47,
      symbol: 'SOL',
      domain: 'perp',
      learningComparable: true,
    });

    const pred = getPrediction(id);
    expect(pred).not.toBeNull();
    expect(pred!.marketProbability).toBeCloseTo(0.47, 6);
    expect(pred!.learningComparable).toBe(true);
  });

  it('recordOutcome with explicit pnl writes that value directly (not Polymarket computation)', () => {
    const id = createPrediction({
      marketId: 'perp:ETH',
      marketTitle: 'ETH long test',
      predictedOutcome: 'YES',
      predictedProbability: 0.65,
      modelProbability: 0.65,
      marketProbability: 0.5,
      symbol: 'ETH',
      domain: 'perp',
      learningComparable: true,
      executed: true,
      executionPrice: 3000,
      positionSize: 0.1,
    });

    recordOutcome({ id, outcome: 'YES', outcomeBasis: 'final', pnl: 12.5 });

    const db = openDatabase();
    const row = db.prepare('SELECT pnl, outcome_basis FROM predictions WHERE id = ?').get(id) as any;
    expect(row.pnl).toBeCloseTo(12.5, 4);
    expect(row.outcome_basis).toBe('final');
    expect(countFinalPredictions()).toBe(0);
  });

  it('recordOutcome demotes synthetic perp comparable rows on final resolution', () => {
    const id = createPrediction({
      marketId: 'perp:ETH',
      marketTitle: 'ETH short test',
      predictedOutcome: 'NO',
      predictedProbability: 0.65,
      modelProbability: 0.65,
      marketProbability: 0.47,
      symbol: 'ETH',
      domain: 'perp',
      learningComparable: true,
      executed: true,
    });

    const db = openDatabase();
    db.prepare('UPDATE predictions SET market_probability = 0.5, learning_comparable = 1 WHERE id = ?').run(id);

    recordOutcome({ id, outcome: 'YES', outcomeBasis: 'final', pnl: -12.5 });

    const row = db
      .prepare('SELECT learning_comparable AS learningComparable, outcome_basis AS outcomeBasis FROM predictions WHERE id = ?')
      .get(id) as { learningComparable: number; outcomeBasis: string };
    expect(row.learningComparable).toBe(0);
    expect(row.outcomeBasis).toBe('final');
  });

  it('recordOutcome with negative pnl (loss) stores the correct negative value', () => {
    const id = createPrediction({
      marketId: 'perp:BTC',
      marketTitle: 'BTC short test',
      predictedOutcome: 'NO',
      predictedProbability: 0.6,
      modelProbability: 0.6,
      marketProbability: 0.5,
      symbol: 'BTC',
      domain: 'perp',
      learningComparable: true,
      executed: true,
    });

    recordOutcome({ id, outcome: 'YES', outcomeBasis: 'final', pnl: -8.25 });

    const db = openDatabase();
    const row = db.prepare('SELECT pnl, outcome FROM predictions WHERE id = ?').get(id) as any;
    expect(row.pnl).toBeCloseTo(-8.25, 4);
    expect(row.outcome).toBe('YES');
  });

  it('recordOutcome without explicit pnl falls back to positionSize-based computation', () => {
    const id = createPrediction({
      marketId: 'perp:SOL',
      marketTitle: 'SOL long fallback',
      predictedOutcome: 'YES',
      predictedProbability: 0.65,
      modelProbability: 0.65,
      marketProbability: 0.5,
      symbol: 'SOL',
      domain: 'perp',
      learningComparable: true,
      executed: true,
      executionPrice: 150,
      positionSize: 0.1,
    });

    // Wrong prediction: predicted YES, outcome is NO → positionSize-based loss
    recordOutcome({ id, outcome: 'NO', outcomeBasis: 'estimated' });

    const db = openDatabase();
    const row = db.prepare('SELECT pnl FROM predictions WHERE id = ?').get(id) as any;
    // else branch: pnl = -positionSize
    expect(row.pnl).toBeCloseTo(-0.1, 4);
  });

  it('recordOutcome updates signal weights when prediction signal scores are stored', () => {
    const before = getSignalWeights('global');
    const id = createPrediction({
      marketId: 'perp:ADA',
      marketTitle: 'ADA long weighted learning',
      predictedOutcome: 'YES',
      predictedProbability: 0.7,
      modelProbability: 0.7,
      marketProbability: 0.5,
      domain: 'global',
      learningComparable: true,
      signalScores: {
        technical: 0.9,
        news: 0.2,
        onChain: 0.1,
      },
      signalWeightsSnapshot: {
        technical: 0.5,
        news: 0.3,
        onChain: 0.2,
      },
    });

    recordOutcome({ id, outcome: 'YES', outcomeBasis: 'final', pnl: 5 });

    const after = getSignalWeights('global');
    expect(before).toBeNull();
    expect(after).not.toBeNull();
    expect(after!.technical).toBeGreaterThan(0.5);
    expect(after!.news).toBeLessThan(0.3);
    expect(after!.onChain).toBeLessThan(0.2);
  });
});
