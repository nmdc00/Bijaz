import { describe, it, expect, beforeEach, vi } from 'vitest';

type PredictionRow = {
  id: string;
  predictedOutcome?: string | null;
  predictedProbability?: number | null;
  executed?: number;
  executionPrice?: number | null;
  positionSize?: number | null;
  outcome?: string | null;
  pnl?: number | null;
};

const state = vi.hoisted(() => ({
  cashBalance: 0,
  predictions: new Map<string, PredictionRow>(),
  trades: [] as Array<{
    predictionId?: string | null;
    marketId: string;
    marketTitle: string;
    outcome: 'YES' | 'NO';
    side: 'buy' | 'sell';
    price?: number | null;
    amount?: number | null;
    shares?: number | null;
  }>,
}));

vi.mock('../src/memory/db.js', () => {
  return {
    openDatabase: () => ({
      prepare: (sql: string) => {
        if (sql.includes('SELECT cash_balance')) {
          return {
            get: () => ({ cashBalance: state.cashBalance, updatedAt: new Date().toISOString() }),
          };
        }
        if (sql.includes('INSERT INTO portfolio_state')) {
          return {
            run: ({ cashBalance }: { cashBalance: number }) => {
              state.cashBalance = cashBalance;
              return {};
            },
          };
        }
        if (sql.includes('INSERT INTO predictions')) {
          return {
            run: (params: Record<string, unknown>) => {
              state.predictions.set(String(params.id), {
                id: String(params.id),
                predictedOutcome: (params.predictedOutcome as string | null) ?? null,
                predictedProbability: (params.predictedProbability as number | null) ?? null,
                executed: Number(params.executed ?? 0),
                executionPrice: (params.executionPrice as number | null) ?? null,
                positionSize: (params.positionSize as number | null) ?? null,
                outcome: null,
                pnl: null,
              });
              return {};
            },
          };
        }
        if (sql.includes('INSERT INTO trades')) {
          return {
            run: (params: Record<string, unknown>) => {
              state.trades.push({
                predictionId: (params.predictionId as string | null) ?? null,
                marketId: String(params.marketId),
                marketTitle: String(params.marketTitle),
                outcome: String(params.outcome) as 'YES' | 'NO',
                side: String(params.side) as 'buy' | 'sell',
                price: (params.price as number | null) ?? null,
                amount: (params.amount as number | null) ?? null,
                shares: (params.shares as number | null) ?? null,
              });
              return {};
            },
          };
        }
        if (sql.includes('FROM trades') && sql.includes('WHERE prediction_id = ?')) {
          return {
            all: (predictionId: string) =>
              state.trades
                .filter((trade) => trade.predictionId === predictionId)
                .map((trade, index) => ({
                  id: index + 1,
                  predictionId: trade.predictionId ?? null,
                  marketId: trade.marketId,
                  marketTitle: trade.marketTitle,
                  outcome: trade.outcome,
                  side: trade.side,
                  price: trade.price ?? null,
                  amount: trade.amount ?? null,
                  shares: trade.shares ?? null,
                  createdAt: new Date().toISOString(),
                })),
          };
        }
        if (sql.includes('UPDATE predictions') && sql.includes('executed = 1')) {
          return {
            run: (params: Record<string, unknown>) => {
              const row = state.predictions.get(String(params.id));
              if (!row) return {};
              row.executed = 1;
              row.executionPrice = (params.executionPrice as number | null) ?? null;
              row.positionSize = (params.positionSize as number | null) ?? null;
              return {};
            },
          };
        }
        if (sql.includes('SELECT outcome') && sql.includes('FROM predictions')) {
          return {
            get: (id: string) => {
              const row = state.predictions.get(String(id));
              if (!row) return undefined;
              return {
                outcome: row.outcome ?? null,
                predictedOutcome: row.predictedOutcome ?? null,
                predictedProbability: row.predictedProbability ?? null,
                executed: row.executed ?? 0,
                executionPrice: row.executionPrice ?? null,
                positionSize: row.positionSize ?? null,
              };
            },
          };
        }
        if (sql.includes('UPDATE predictions') && sql.includes('brier_contribution')) {
          return {
            run: (params: Record<string, unknown>) => {
              const row = state.predictions.get(String(params.id));
              if (!row) return {};
              row.outcome = (params.outcome as string | null) ?? null;
              row.pnl = (params.pnl as number | null) ?? null;
              return {};
            },
          };
        }
        if (sql.includes('FROM predictions') && sql.includes('WHERE id = ?')) {
          return {
            get: (id: string) => {
              const row = state.predictions.get(String(id));
              if (!row) return undefined;
              return {
                id: row.id,
                marketId: 'm1',
                marketTitle: 'Test market',
                predictedOutcome: row.predictedOutcome,
                predictedProbability: row.predictedProbability,
                confidenceLevel: null,
                confidenceRaw: null,
                confidenceAdjusted: null,
                reasoning: null,
                keyFactors: null,
                intelIds: null,
                domain: null,
                createdAt: new Date().toISOString(),
                executed: row.executed ?? 0,
                executionPrice: row.executionPrice,
                positionSize: row.positionSize,
                outcome: row.outcome,
                outcomeTimestamp: new Date().toISOString(),
                pnl: row.pnl,
              };
            },
          };
        }
        return {
          get: () => undefined,
          all: () => [],
          run: () => ({}),
        };
      },
      exec: () => undefined,
      pragma: () => undefined,
    }),
  };
});

import { createPrediction, getPrediction, recordExecution } from '../src/memory/predictions.js';
import { recordOutcome } from '../src/memory/calibration.js';
import { adjustCashBalance, getCashBalance, setCashBalance } from '../src/memory/portfolio.js';
import { recordTrade } from '../src/memory/trades.js';

describe('portfolio cash tracking', () => {
  beforeEach(() => {
    state.cashBalance = 0;
    state.predictions.clear();
    state.trades = [];
  });

  it('sets and adjusts cash balance', () => {
    setCashBalance(500);
    expect(getCashBalance()).toBe(500);

    adjustCashBalance(-125.5);
    expect(getCashBalance()).toBeCloseTo(374.5, 6);
  });

  it('updates cash and pnl on execution and resolution', () => {
    setCashBalance(1000);

    const predictionId = createPrediction({
      marketId: 'm1',
      marketTitle: 'Test market',
      predictedOutcome: 'YES',
      predictedProbability: 0.55,
      confidenceLevel: 'medium',
    });

    recordExecution({
      id: predictionId,
      executionPrice: 0.5,
      positionSize: 100,
    });

    expect(getCashBalance()).toBeCloseTo(900, 6);

    recordTrade({
      predictionId,
      marketId: 'm1',
      marketTitle: 'Test market',
      outcome: 'YES',
      side: 'buy',
      price: 0.5,
      amount: 100,
      shares: 200,
    });

    recordOutcome({
      id: predictionId,
      outcome: 'YES',
    });

    expect(getCashBalance()).toBeCloseTo(1100, 6);

    const prediction = getPrediction(predictionId);
    expect(prediction?.pnl).toBeCloseTo(100, 6);
  });
});
