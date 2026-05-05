import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PaperExecutor } from '../../src/execution/modes/paper.js';
import { WebhookExecutor } from '../../src/execution/modes/webhook.js';
import { listLearningCases } from '../../src/memory/learning_cases.js';
import { listPredictions } from '../../src/memory/predictions.js';

vi.mock('node-fetch', () => ({
  default: vi.fn(async () => ({ ok: true, status: 200 })),
}));

function useTempDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-comparator-hygiene-'));
  process.env.THUFIR_DB_PATH = join(dir, 'thufir.sqlite');
}

describe('execution comparator hygiene', () => {
  beforeEach(() => {
    useTempDb();
  });

  it('paper prediction-market executions remain comparable when both model and market probabilities exist', async () => {
    const executor = new PaperExecutor();
    await executor.execute(
      {
        id: 'pm-1',
        question: 'Will BTC close green today?',
        outcomes: ['YES', 'NO'],
        prices: { YES: 0.58, NO: 0.42 },
        platform: 'polymarket',
        kind: 'prediction',
      },
      {
        action: 'buy',
        outcome: 'YES',
        amount: 25,
        modelProbability: 0.67,
      }
    );

    const [prediction] = listPredictions(10);
    expect(prediction?.domain).toBeUndefined();
    expect(prediction?.marketProbability).toBeCloseTo(0.58, 6);
    expect(prediction?.modelProbability).toBeCloseTo(0.67, 6);
    expect(prediction?.learningComparable).toBe(true);
    const [learningCase] = listLearningCases({ sourcePredictionId: prediction?.id, limit: 1 });
    expect(learningCase).toMatchObject({
      caseType: 'comparable_forecast',
      comparable: true,
      comparatorKind: 'market_price',
    });
    expect(learningCase?.belief).toMatchObject({ modelProbability: 0.67, predictedOutcome: 'YES' });
    expect(learningCase?.baseline).toMatchObject({ marketProbability: 0.58 });
  });

  it('webhook prediction-market executions do not mark rows comparable without a model probability', async () => {
    const executor = new WebhookExecutor('https://example.test/webhook');
    await executor.execute(
      {
        id: 'pm-2',
        question: 'Will ETH ETF volume rise this week?',
        outcomes: ['YES', 'NO'],
        prices: { YES: 0.41, NO: 0.59 },
        platform: 'polymarket',
        kind: 'prediction',
      },
      {
        action: 'buy',
        outcome: 'YES',
        amount: 10,
      }
    );

    const [prediction] = listPredictions(10);
    expect(prediction?.marketProbability).toBeNull();
    expect(prediction?.learningComparable).toBe(false);
    const [learningCase] = listLearningCases({ sourcePredictionId: prediction?.id, limit: 1 });
    expect(learningCase).toMatchObject({
      caseType: 'comparable_forecast',
      comparable: false,
      exclusionReason: 'missing_model_probability',
    });
  });
});
