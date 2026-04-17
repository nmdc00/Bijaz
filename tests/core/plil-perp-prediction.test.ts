import { describe, it, expect, beforeEach } from 'vitest';
import { PaperExecutor } from '../../src/execution/modes/paper.js';
import { findOpenPerpPrediction } from '../../src/memory/predictions.js';
import { openDatabase } from '../../src/memory/db.js';

function freshDb() {
  const db = openDatabase();
  db.exec(`DELETE FROM predictions`);
  db.exec(`DELETE FROM paper_perp_positions`);
  db.exec(`DELETE FROM paper_perp_fills`);
  db.exec(`DELETE FROM paper_perp_book`);
}

const perpMarket = {
  id: 'BTC',
  symbol: 'BTC',
  kind: 'perp' as const,
  question: 'BTC perp',
  markPrice: 75000,
};

describe('PLIL perp prediction tracking', () => {
  beforeEach(freshDb);

  it('creates a prediction row on LLM-originated perp open', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 500 });
    await executor.execute(perpMarket, {
      action: 'buy',
      side: 'buy',
      symbol: 'BTC',
      size: 0.001,
      orderType: 'market',
      leverage: 5,
      modelProbability: 0.78,
      reasoning: 'test thesis',
    });

    const id = findOpenPerpPrediction('BTC');
    expect(id).toBeTruthy();

    const db = openDatabase();
    const row = db.prepare(`SELECT domain, model_probability, predicted_outcome, outcome FROM predictions WHERE id = ?`).get(id) as any;
    expect(row.domain).toBe('perp');
    expect(row.model_probability).toBeCloseTo(0.78);
    expect(row.predicted_outcome).toBe('YES');
    expect(row.outcome).toBeNull();
  });

  it('does not create a prediction when modelProbability is absent', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 500 });
    await executor.execute(perpMarket, {
      action: 'buy',
      side: 'buy',
      symbol: 'BTC',
      size: 0.001,
      orderType: 'market',
      leverage: 5,
    });
    expect(findOpenPerpPrediction('BTC')).toBeNull();
  });

  it('resolves prediction to YES on profitable close', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 500 });
    await executor.execute(perpMarket, {
      action: 'buy',
      side: 'buy',
      symbol: 'BTC',
      size: 0.001,
      orderType: 'market',
      leverage: 5,
      modelProbability: 0.78,
    });

    const predId = findOpenPerpPrediction('BTC');
    expect(predId).toBeTruthy();

    // Close at higher price — profitable
    await executor.execute({ ...perpMarket, markPrice: 76000 }, {
      action: 'sell',
      side: 'sell',
      symbol: 'BTC',
      size: 0.001,
      orderType: 'market',
      reduceOnly: true,
    });

    const db = openDatabase();
    const row = db.prepare(`SELECT outcome, outcome_basis FROM predictions WHERE id = ?`).get(predId) as any;
    expect(row.outcome).toBe('YES');
    expect(row.outcome_basis).toBe('final');
  });

  it('resolves prediction to NO on losing close', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 500 });
    await executor.execute(perpMarket, {
      action: 'buy',
      side: 'buy',
      symbol: 'BTC',
      size: 0.001,
      orderType: 'market',
      leverage: 5,
      modelProbability: 0.72,
    });

    const predId = findOpenPerpPrediction('BTC');

    // Close at lower price — loss
    await executor.execute({ ...perpMarket, markPrice: 74000 }, {
      action: 'sell',
      side: 'sell',
      symbol: 'BTC',
      size: 0.001,
      orderType: 'market',
      reduceOnly: true,
    });

    const db = openDatabase();
    const row = db.prepare(`SELECT outcome, outcome_basis FROM predictions WHERE id = ?`).get(predId) as any;
    expect(row.outcome).toBe('NO');
    expect(row.outcome_basis).toBe('final');
  });
});
