import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getEvaluationSummary } from '../../src/core/evaluation.js';
import { openDatabase } from '../../src/memory/db.js';

const originalDbPath = process.env.THUFIR_DB_PATH;
let dbDir: string | null = null;
let dbPath: string | null = null;

function db() {
  return openDatabase();
}

function seedMarket(input: {
  id: string;
  question: string;
  category: string;
  prices: Record<string, number>;
  createdAt: string;
}): void {
  db()
    .prepare(
      `
        INSERT INTO market_cache (
          id,
          question,
          outcomes,
          prices,
          category,
          created_at
        ) VALUES (
          @id,
          @question,
          @outcomes,
          @prices,
          @category,
          @createdAt
        )
      `
    )
    .run({
      id: input.id,
      question: input.question,
      outcomes: JSON.stringify(['YES', 'NO']),
      prices: JSON.stringify(input.prices),
      category: input.category,
      createdAt: input.createdAt,
    });
}

function seedPrediction(input: {
  id: string;
  marketId: string;
  marketTitle: string;
  domain: string;
  predictedOutcome: 'YES' | 'NO';
  predictedProbability: number;
  executionPrice: number;
  executed: number;
  outcome: 'YES' | 'NO' | null;
  brierContribution: number | null;
  createdAt: string;
  outcomeTimestamp: string | null;
}): void {
  db()
    .prepare(
      `
        INSERT INTO predictions (
          id,
          market_id,
          market_title,
          predicted_outcome,
          predicted_probability,
          executed,
          execution_price,
          domain,
          created_at,
          outcome,
          outcome_timestamp,
          brier_contribution
        ) VALUES (
          @id,
          @marketId,
          @marketTitle,
          @predictedOutcome,
          @predictedProbability,
          @executed,
          @executionPrice,
          @domain,
          @createdAt,
          @outcome,
          @outcomeTimestamp,
          @brierContribution
        )
      `
    )
    .run({
      ...input,
      outcome: input.outcome,
      outcomeTimestamp: input.outcomeTimestamp,
    });
}

function seedTrade(input: {
  marketId: string;
  marketTitle: string;
  outcome: 'YES' | 'NO';
  side: 'buy' | 'sell';
  amount: number;
  shares: number;
  price: number;
  createdAt: string;
}): void {
  db()
    .prepare(
      `
        INSERT INTO trades (
          market_id,
          market_title,
          outcome,
          side,
          amount,
          shares,
          price,
          created_at
        ) VALUES (
          @marketId,
          @marketTitle,
          @outcome,
          @side,
          @amount,
          @shares,
          @price,
          @createdAt
        )
      `
    )
    .run(input);
}

function seedDecisionAudit(input: {
  createdAt: string;
  criticApproved: number | null;
  fragilityScore: number | null;
  toolTrace: string | null;
}): void {
  db()
    .prepare(
      `
        INSERT INTO decision_audit (
          created_at,
          critic_approved,
          fragility_score,
          tool_trace
        ) VALUES (
          @createdAt,
          @criticApproved,
          @fragilityScore,
          @toolTrace
        )
      `
    )
    .run(input);
}

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'thufir-evaluation-'));
  dbPath = join(dbDir, 'thufir.sqlite');
  process.env.THUFIR_DB_PATH = dbPath;
  openDatabase(dbPath);
});

afterEach(() => {
  process.env.THUFIR_DB_PATH = originalDbPath;
  if (dbPath) {
    rmSync(dbPath, { force: true });
    dbPath = null;
  }
  if (dbDir) {
    rmSync(dbDir, { recursive: true, force: true });
    dbDir = null;
  }
});

describe('getEvaluationSummary', () => {
  it('aggregates totals, by-domain metrics, pnl, calibration, and process stats', () => {
    const recentAt = '2026-04-23T12:00:00.000Z';

    seedMarket({
      id: 'm-macro-1',
      question: 'Macro market',
      category: 'macro',
      prices: { YES: 0.6, NO: 0.4 },
      createdAt: recentAt,
    });
    seedMarket({
      id: 'm-crypto-1',
      question: 'Crypto market',
      category: 'crypto',
      prices: { YES: 0.8, NO: 0.2 },
      createdAt: recentAt,
    });

    seedPrediction({
      id: 'p-macro-1',
      marketId: 'm-macro-1',
      marketTitle: 'Macro market',
      domain: 'macro',
      predictedOutcome: 'YES',
      predictedProbability: 0.7,
      executionPrice: 0.4,
      executed: 1,
      outcome: 'YES',
      brierContribution: 0.09,
      createdAt: recentAt,
      outcomeTimestamp: recentAt,
    });
    seedPrediction({
      id: 'p-crypto-1',
      marketId: 'm-crypto-1',
      marketTitle: 'Crypto market',
      domain: 'crypto',
      predictedOutcome: 'NO',
      predictedProbability: 0.3,
      executionPrice: 0.5,
      executed: 1,
      outcome: 'YES',
      brierContribution: 0.49,
      createdAt: recentAt,
      outcomeTimestamp: recentAt,
    });

    seedTrade({
      marketId: 'm-macro-1',
      marketTitle: 'Macro market',
      outcome: 'YES',
      side: 'buy',
      amount: 40,
      shares: 100,
      price: 0.4,
      createdAt: recentAt,
    });
    seedTrade({
      marketId: 'm-macro-1',
      marketTitle: 'Macro market',
      outcome: 'YES',
      side: 'sell',
      amount: 60,
      shares: 100,
      price: 0.6,
      createdAt: recentAt,
    });
    seedTrade({
      marketId: 'm-crypto-1',
      marketTitle: 'Crypto market',
      outcome: 'YES',
      side: 'buy',
      amount: 40,
      shares: 100,
      price: 0.4,
      createdAt: recentAt,
    });

    seedDecisionAudit({
      createdAt: recentAt,
      criticApproved: 1,
      fragilityScore: 0.25,
      toolTrace: '[{"tool":"evaluation_summary"}]',
    });
    seedDecisionAudit({
      createdAt: recentAt,
      criticApproved: 0,
      fragilityScore: 0.75,
      toolTrace: null,
    });

    const summary = getEvaluationSummary();

    expect(summary.totals.predictions).toBe(2);
    expect(summary.totals.executedPredictions).toBe(2);
    expect(summary.totals.resolvedPredictions).toBe(2);
    expect(summary.totals.accuracy).toBe(0.5);
    expect(summary.totals.avgBrier).toBeCloseTo(0.29, 6);
    expect(summary.totals.avgEdge).toBeCloseTo(0.05, 6);
    expect(summary.totals.realizedPnl).toBe(-20);
    expect(summary.totals.unrealizedPnl).toBe(40);
    expect(summary.totals.totalPnl).toBe(20);
    expect(summary.totals.winRate).toBe(0.5);

    expect(summary.byDomain).toHaveLength(2);
    expect(summary.byDomain[0]).toMatchObject({
      domain: 'macro',
      predictions: 1,
      executedPredictions: 1,
      resolvedPredictions: 1,
      accuracy: 1,
      realizedPnl: 20,
      unrealizedPnl: 0,
      totalPnl: 20,
    });
    expect(summary.byDomain[1]).toMatchObject({
      domain: 'crypto',
      predictions: 1,
      executedPredictions: 1,
      resolvedPredictions: 1,
      accuracy: 0,
      realizedPnl: -40,
      unrealizedPnl: 40,
      totalPnl: 0,
    });
    expect(summary.byDomain[0]?.avgBrier).toBeCloseTo(0.09, 6);
    expect(summary.byDomain[0]?.avgEdge).toBeCloseTo(0.3, 6);
    expect(summary.byDomain[1]?.avgBrier).toBeCloseTo(0.49, 6);
    expect(summary.byDomain[1]?.avgEdge).toBeCloseTo(-0.2, 6);

    expect(summary.process).toEqual({
      decisions: 2,
      criticApproved: 1,
      criticRejected: 1,
      avgFragility: 0.5,
      withToolTrace: 1,
    });
  });

  it('filters results by domain', () => {
    const recentAt = '2026-04-23T12:00:00.000Z';

    seedMarket({
      id: 'm-macro-2',
      question: 'Macro market',
      category: 'macro',
      prices: { YES: 0.6, NO: 0.4 },
      createdAt: recentAt,
    });
    seedMarket({
      id: 'm-crypto-2',
      question: 'Crypto market',
      category: 'crypto',
      prices: { YES: 0.8, NO: 0.2 },
      createdAt: recentAt,
    });

    seedPrediction({
      id: 'p-macro-2',
      marketId: 'm-macro-2',
      marketTitle: 'Macro market',
      domain: 'macro',
      predictedOutcome: 'YES',
      predictedProbability: 0.7,
      executionPrice: 0.4,
      executed: 1,
      outcome: 'YES',
      brierContribution: 0.09,
      createdAt: recentAt,
      outcomeTimestamp: recentAt,
    });
    seedPrediction({
      id: 'p-crypto-2',
      marketId: 'm-crypto-2',
      marketTitle: 'Crypto market',
      domain: 'crypto',
      predictedOutcome: 'NO',
      predictedProbability: 0.3,
      executionPrice: 0.5,
      executed: 1,
      outcome: 'YES',
      brierContribution: 0.49,
      createdAt: recentAt,
      outcomeTimestamp: recentAt,
    });

    seedTrade({
      marketId: 'm-macro-2',
      marketTitle: 'Macro market',
      outcome: 'YES',
      side: 'buy',
      amount: 40,
      shares: 100,
      price: 0.4,
      createdAt: recentAt,
    });
    seedTrade({
      marketId: 'm-macro-2',
      marketTitle: 'Macro market',
      outcome: 'YES',
      side: 'sell',
      amount: 60,
      shares: 100,
      price: 0.6,
      createdAt: recentAt,
    });
    seedTrade({
      marketId: 'm-crypto-2',
      marketTitle: 'Crypto market',
      outcome: 'YES',
      side: 'buy',
      amount: 40,
      shares: 100,
      price: 0.4,
      createdAt: recentAt,
    });

    const summary = getEvaluationSummary({ domain: 'macro' });

    expect(summary.totals.predictions).toBe(1);
    expect(summary.totals.executedPredictions).toBe(1);
    expect(summary.totals.resolvedPredictions).toBe(1);
    expect(summary.totals.accuracy).toBe(1);
    expect(summary.totals.avgBrier).toBeCloseTo(0.09, 6);
    expect(summary.totals.avgEdge).toBeCloseTo(0.3, 6);
    expect(summary.totals.realizedPnl).toBe(20);
    expect(summary.totals.unrealizedPnl).toBe(0);
    expect(summary.totals.totalPnl).toBe(20);
    expect(summary.byDomain).toHaveLength(1);
    expect(summary.byDomain[0]?.domain).toBe('macro');
  });

  it('applies the sliding window to predictions, outcomes, and trades', () => {
    const recentAt = new Date().toISOString();
    const oldAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    seedMarket({
      id: 'm-old',
      question: 'Old market',
      category: 'macro',
      prices: { YES: 0.7, NO: 0.3 },
      createdAt: oldAt,
    });
    seedMarket({
      id: 'm-recent',
      question: 'Recent market',
      category: 'crypto',
      prices: { YES: 0.5, NO: 0.5 },
      createdAt: recentAt,
    });

    seedPrediction({
      id: 'p-old',
      marketId: 'm-old',
      marketTitle: 'Old market',
      domain: 'macro',
      predictedOutcome: 'YES',
      predictedProbability: 0.6,
      executionPrice: 0.5,
      executed: 1,
      outcome: 'YES',
      brierContribution: 0.16,
      createdAt: oldAt,
      outcomeTimestamp: oldAt,
    });
    seedPrediction({
      id: 'p-recent',
      marketId: 'm-recent',
      marketTitle: 'Recent market',
      domain: 'crypto',
      predictedOutcome: 'NO',
      predictedProbability: 0.2,
      executionPrice: 0.4,
      executed: 1,
      outcome: 'YES',
      brierContribution: 0.64,
      createdAt: recentAt,
      outcomeTimestamp: recentAt,
    });

    seedTrade({
      marketId: 'm-old',
      marketTitle: 'Old market',
      outcome: 'YES',
      side: 'buy',
      amount: 40,
      shares: 100,
      price: 0.4,
      createdAt: oldAt,
    });
    seedTrade({
      marketId: 'm-old',
      marketTitle: 'Old market',
      outcome: 'YES',
      side: 'sell',
      amount: 55,
      shares: 100,
      price: 0.55,
      createdAt: oldAt,
    });
    seedTrade({
      marketId: 'm-recent',
      marketTitle: 'Recent market',
      outcome: 'YES',
      side: 'buy',
      amount: 30,
      shares: 100,
      price: 0.3,
      createdAt: recentAt,
    });
    seedTrade({
      marketId: 'm-recent',
      marketTitle: 'Recent market',
      outcome: 'YES',
      side: 'sell',
      amount: 50,
      shares: 100,
      price: 0.5,
      createdAt: recentAt,
    });

    const summary = getEvaluationSummary({ windowDays: 1 });

    expect(summary.windowDays).toBe(1);
    expect(summary.totals.predictions).toBe(1);
    expect(summary.totals.resolvedPredictions).toBe(1);
    expect(summary.totals.accuracy).toBe(0);
    expect(summary.totals.avgBrier).toBeCloseTo(0.64, 6);
    expect(summary.totals.realizedPnl).toBe(20);
    expect(summary.totals.unrealizedPnl).toBe(0);
    expect(summary.totals.totalPnl).toBe(20);
    expect(summary.byDomain).toHaveLength(1);
    expect(summary.byDomain[0]?.domain).toBe('crypto');
    expect(summary.byDomain[0]?.realizedPnl).toBe(20);
  });
});
