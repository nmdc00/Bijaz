import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createPrediction, getPrediction } from '../../src/memory/predictions.js';
import { countFinalPredictions, recordOutcome } from '../../src/memory/calibration.js';
import { openDatabase } from '../../src/memory/db.js';

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

  it('perp prediction stores execution fields and PLIL columns correctly', () => {
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
    expect(pred!.learningComparable).toBe(true);
    expect(pred!.executed).toBe(true);
    expect(pred!.executionPrice).toBeCloseTo(150.5, 4);
    expect(pred!.positionSize).toBeCloseTo(0.667, 4);
    expect(pred!.outcomeBasis).toBe('legacy');
    expect(pred!.resolutionStatus).toBe('open');
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
    expect(countFinalPredictions()).toBe(1);
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
});
