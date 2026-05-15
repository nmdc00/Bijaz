import { describe, expect, it } from 'vitest';

import { buildPerpExecutionLearningCase } from '../../src/core/perp_lifecycle.js';
import { deriveTradeSimilarityFeatures } from '../../src/core/trade_similarity_feature_derivation.js';
import type { TradeDossier } from '../../src/memory/trade_dossiers.js';

describe('trade similarity feature derivation', () => {
  it('derives deterministic typed features from dossier review and learning-case context', () => {
    const dossier: TradeDossier = {
      id: 'dossier-derivation-1',
      symbol: 'BTC',
      status: 'closed',
      direction: 'long',
      strategySource: 'tool_executor',
      executionMode: 'paper',
      sourceTradeId: 812,
      sourcePredictionId: null,
      sourceHypothesisId: 'hyp-812',
      proposalRecordId: null,
      triggerReason: 'technical',
      openedAt: '2026-05-15T14:30:00.000Z',
      closedAt: '2026-05-15T15:05:00.000Z',
      dossier: {
        version: 'v2.2',
        context: {
          signalClass: 'momentum_breakout',
          marketRegime: 'trend_transition',
          volatilityBucket: 'high',
          liquidityBucket: 'thin',
          entryTrigger: 'technical',
          tradeArchetype: 'intraday',
          newsSubtype: 'earnings',
        },
        gate: {
          verdict: 'resize',
        },
        close: {
          exitMode: 'take_profit',
        },
      },
      review: {
        reviewVersion: 'v2.2',
        thesisVerdict: 'correct',
        entryQuality: 'weak',
        sizingQuality: 'adequate',
        mainFailureMode: 'Late or stretched entry',
        mainSuccessDriver: 'Gate intervention preserved edge',
      },
      retrieval: {
        retrievedCases: [{ dossierId: 'prior-1' }, { dossierId: 'prior-2' }],
        retrievalRiskFlags: ['late_entry', 'thin_liquidity'],
      },
      policyTrace: null,
      createdAt: '2026-05-15T15:05:01.000Z',
      updatedAt: '2026-05-15T15:05:01.000Z',
    };

    const learningCase = buildPerpExecutionLearningCase({
      symbol: 'BTC',
      executionMode: 'paper',
      tradeId: 812,
      dossierId: dossier.id,
      hypothesisId: 'hyp-812',
      capturedAtMs: Date.parse('2026-05-15T15:05:00.000Z'),
      side: 'sell',
      size: 0.01,
      leverage: 2,
      signalClass: 'momentum_breakout',
      marketRegime: 'trend_transition',
      volatilityBucket: 'high',
      liquidityBucket: 'thin',
      tradeArchetype: 'intraday',
      entryTrigger: 'technical',
      expectedEdge: 0.09,
      invalidationPrice: 62000,
      timeStopAtMs: Date.parse('2026-05-15T18:00:00.000Z'),
      entryPrice: 64000,
      exitPrice: 65100,
      pricePathHigh: 65250,
      pricePathLow: 63900,
      thesisCorrect: true,
      thesisInvalidationHit: false,
      exitMode: 'take_profit',
      realizedPnlUsd: 11.4,
      netRealizedPnlUsd: 11,
      realizedFeeUsd: 0.4,
      directionScore: 0.9,
      timingScore: 0.42,
      sizingScore: 0.64,
      exitScore: 0.82,
      capturedR: 1.3,
      leftOnTableR: 0.1,
      wouldHit2R: false,
      wouldHit3R: false,
      maeProxy: 0.2,
      mfeProxy: 0.9,
      reasoning: 'Breakout held after resize.',
      planContext: {
        noveltyScore: 0.82,
        entryStretchPct: 6.2,
        portfolioOverlapBucket: 'btc_beta',
      },
      snapshot: {
        createdAtIso: '2026-05-15T15:05:00.000Z',
      },
      requestedSize: 0.02,
      approvedSize: 0.01,
      requestedLeverage: 3,
      approvedLeverage: 2,
      gateVerdict: 'resize',
      gateReasonCode: 'stretch_guard',
    });

    const first = deriveTradeSimilarityFeatures({ dossier, learningCase });
    const second = deriveTradeSimilarityFeatures({ dossier, learningCase });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      dossierId: dossier.id,
      symbol: 'BTC',
      signalClass: 'momentum_breakout',
      tradeArchetype: 'intraday',
      marketRegime: 'trend_transition',
      volatilityBucket: 'high',
      liquidityBucket: 'thin',
      entryTrigger: 'technical',
      newsSubtype: 'earnings',
      gateVerdict: 'resize',
      failureMode: 'late_or_stretched_entry',
      successDriver: 'gate_intervention_preserved_edge',
      thesisVerdict: 'correct',
      entryQuality: 'weak',
      sizingQuality: 'adequate',
      sourceCount: 2,
      conflictingEvidenceCount: 2,
      catalystFreshnessBucket: 'fresh',
      entryExtensionBucket: 'chasing',
      portfolioOverlapBucket: 'btc_beta',
      executionConditionBucket: 'fragile',
      sessionBucket: 'us_open',
      regimeTransitionFlag: true,
    });
  });
});
