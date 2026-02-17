import { describe, expect, it } from 'vitest';

import {
  buildExpressionEvaluationPrompt,
  evaluateContextPackEffectiveness,
} from '../../src/discovery/context_pack_effectiveness.js';
import type { ExpressionPlan } from '../../src/discovery/types.js';

function makeExpression(overrides?: Partial<ExpressionPlan>): ExpressionPlan {
  return {
    id: 'expr_btc_1',
    hypothesisId: 'hyp_btc_1',
    symbol: 'BTC/USDT',
    side: 'buy',
    signalClass: 'momentum_breakout',
    marketRegime: 'trending',
    volatilityBucket: 'medium',
    liquidityBucket: 'normal',
    confidence: 0.74,
    expectedEdge: 0.11,
    entryZone: 'market',
    invalidation: 'Break below intraday support.',
    expectedMove: 'Upside continuation through local resistance.',
    orderType: 'market',
    leverage: 3,
    probeSizeUsd: 20,
    newsTrigger: null,
    contextPack: {
      regime: {
        marketRegime: 'trending',
        volatilityBucket: 'medium',
        liquidityBucket: 'normal',
        confidence: 0.8,
        source: 'provider',
      },
      executionQuality: {
        status: 'good',
        score: 0.77,
        recentWinRate: 0.61,
        slippageBps: 4,
        notes: ['stable fills'],
        source: 'provider',
      },
      event: {
        kind: 'technical',
        subtype: 'breakout',
        catalyst: 'momentum cluster',
        confidence: 0.68,
        expiresAtMs: null,
        source: 'provider',
      },
      portfolioState: {
        posture: 'neutral',
        availableBalanceUsd: 1200,
        netExposureUsd: 150,
        openPositions: 2,
        source: 'provider',
      },
      missing: [],
    },
    ...overrides,
  };
}

describe('context pack effectiveness evaluation', () => {
  it('injects context pack section when enabled and omits it when disabled', () => {
    const expression = makeExpression();

    const baselinePrompt = buildExpressionEvaluationPrompt(expression, {
      includeContextPack: false,
    });
    const contextPrompt = buildExpressionEvaluationPrompt(expression, {
      includeContextPack: true,
    });

    expect(baselinePrompt).not.toContain('## Context Pack');
    expect(contextPrompt).toContain('## Context Pack');
    expect(contextPrompt).toContain('execution: good');
  });

  it('computes offline A/B metrics with positive context-pack delta', () => {
    const expressions: ExpressionPlan[] = [
      makeExpression(),
      makeExpression({
        id: 'expr_eth_1',
        symbol: 'ETH/USDT',
        confidence: 0.69,
        expectedEdge: 0.08,
        contextPack: {
          regime: {
            marketRegime: 'high_vol_expansion',
            volatilityBucket: 'high',
            liquidityBucket: 'deep',
            confidence: 0.71,
            source: 'provider',
          },
          executionQuality: {
            status: 'good',
            score: 0.8,
            recentWinRate: 0.58,
            slippageBps: 6,
            notes: ['liquidity robust'],
            source: 'provider',
          },
          event: {
            kind: 'news_event',
            subtype: 'macro',
            catalyst: 'CPI surprise',
            confidence: 0.62,
            expiresAtMs: null,
            source: 'provider',
          },
          portfolioState: {
            posture: 'risk_on',
            availableBalanceUsd: 900,
            netExposureUsd: 200,
            openPositions: 3,
            source: 'provider',
          },
          missing: [],
        },
      }),
    ];

    const report = evaluateContextPackEffectiveness(expressions, {
      nonTrivialDeltaThreshold: 0.01,
    });

    expect(report.sampleSize).toBe(2);
    expect(report.delta.avgQualityScore).toBeGreaterThan(0);
    expect(report.delta.nonTrivialImprovement).toBe(true);
    expect(report.samples[0]?.contextPackScore).toBeGreaterThanOrEqual(
      report.samples[0]?.baselineScore ?? 0
    );
  });
});
