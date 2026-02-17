import { describe, expect, it } from 'vitest';

import type { MarketClient } from '../../src/execution/market-client.js';
import {
  buildPredictionFromSignalInputs,
  formatDelphiPreview,
  generateDelphiPredictions,
} from '../../src/delphi/surface.js';
import fixture from '../fixtures/v1_5_delphi_signal_inputs.fixture.json';

interface FixtureVariant {
  id: string;
  technicalScore: number;
  newsScore: number;
  onChainScore: number;
  signalConfidence: number;
  expectedDirection: 'above' | 'below';
}

describe('delphi real-signal fixture coverage', () => {
  it('produces prediction deltas for the same symbol when signal inputs change', () => {
    const variants = fixture.variants as FixtureVariant[];
    const predictions = variants.map((variant) =>
      buildPredictionFromSignalInputs({
        symbol: fixture.symbol,
        horizon: fixture.horizon,
        referencePrice: fixture.referencePrice,
        technicalScore: variant.technicalScore,
        newsScore: variant.newsScore,
        onChainScore: variant.onChainScore,
        signalConfidence: variant.signalConfidence,
        signalWeights: fixture.signalWeights,
        inputSource: 'real-signals',
      })
    );

    const byId = new Map(variants.map((variant, idx) => [variant.id, predictions[idx]]));

    for (const variant of variants) {
      expect(byId.get(variant.id)?.direction).toBe(variant.expectedDirection);
    }

    const highTarget = byId.get(fixture.expectations.targetOrder[0]);
    const lowTarget = byId.get(fixture.expectations.targetOrder[1]);

    expect(highTarget?.targetPrice).not.toBeNull();
    expect(lowTarget?.targetPrice).not.toBeNull();
    expect((highTarget?.targetPrice ?? 0) > (fixture.referencePrice ?? 0)).toBe(true);
    expect((lowTarget?.targetPrice ?? 0) < (fixture.referencePrice ?? Number.MAX_SAFE_INTEGER)).toBe(true);
    expect((highTarget?.targetPrice ?? 0) > (lowTarget?.targetPrice ?? 0)).toBe(true);
    expect((highTarget?.confidence ?? 0) - (lowTarget?.confidence ?? 0)).toBeGreaterThanOrEqual(
      fixture.expectations.minConfidenceDelta
    );
  });

  it('keeps /delphi preview non-executing by default while using real signal inputs', async () => {
    const marketClient: MarketClient = {
      isAvailable: () => true,
      listMarkets: async () => [
        {
          id: fixture.symbol,
          question: `${fixture.symbol} market`,
          outcomes: ['LONG', 'SHORT'],
          prices: {},
          platform: 'hyperliquid',
          symbol: fixture.symbol,
          markPrice: fixture.referencePrice,
        },
      ],
      searchMarkets: async () => [
        {
          id: fixture.symbol,
          question: `${fixture.symbol} market`,
          outcomes: ['LONG', 'SHORT'],
          prices: {},
          platform: 'hyperliquid',
          symbol: fixture.symbol,
          markPrice: fixture.referencePrice,
        },
      ],
      getMarket: async () => ({
        id: fixture.symbol,
        question: `${fixture.symbol} market`,
        outcomes: ['LONG', 'SHORT'],
        prices: {},
        platform: 'hyperliquid',
        symbol: fixture.symbol,
        markPrice: fixture.referencePrice,
      }),
    };

    const config = {
      technical: {
        symbols: [`${fixture.symbol}/USDT`],
        signals: {
          weights: fixture.signalWeights,
        },
      },
    } as any;

    const bullish = fixture.variants.find((row) => row.id === fixture.expectations.targetOrder[0]);
    const bearish = fixture.variants.find((row) => row.id === fixture.expectations.targetOrder[1]);

    const depsForVariant = (variant: FixtureVariant) => ({
      getTechnicalSnapshot: async () => ({
        symbol: `${fixture.symbol}/USDT`,
        timeframe: '4h',
        timestamp: Date.now(),
        price: fixture.referencePrice,
        indicators: [],
        overallBias: 'neutral',
        confidence: 0,
      }),
      buildTradeSignal: async () => ({
        symbol: `${fixture.symbol}/USDT`,
        direction: variant.expectedDirection === 'above' ? 'long' : 'short',
        confidence: variant.signalConfidence,
        timeframe: '4h',
        technicalScore: variant.technicalScore,
        newsScore: variant.newsScore,
        onChainScore: variant.onChainScore,
        entryPrice: fixture.referencePrice,
        stopLoss: fixture.referencePrice * 0.98,
        takeProfit: [fixture.referencePrice * 1.02],
        riskRewardRatio: 1,
        positionSize: 0.01,
        technicalReasoning: [],
        newsReasoning: [],
        onChainReasoning: [],
      }),
    });

    const options = {
      horizon: fixture.horizon,
      symbols: [fixture.symbol],
      count: 1,
      dryRun: true,
      output: 'text' as const,
    };

    const bullishPredictions = await generateDelphiPredictions(
      marketClient,
      config,
      options,
      depsForVariant(bullish as FixtureVariant)
    );
    const bearishPredictions = await generateDelphiPredictions(
      marketClient,
      config,
      options,
      depsForVariant(bearish as FixtureVariant)
    );

    expect(bullishPredictions[0]?.inputSource).toBe('real-signals');
    expect(bullishPredictions[0]?.direction).toBe('above');
    expect(bearishPredictions[0]?.direction).toBe('below');
    expect((bullishPredictions[0]?.targetPrice ?? 0) > (bearishPredictions[0]?.targetPrice ?? 0)).toBe(true);

    const preview = formatDelphiPreview(options, bullishPredictions);
    expect(preview).toContain('non-executing by default');
  });
});
