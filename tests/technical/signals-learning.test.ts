import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordOutcome } from '../../src/memory/calibration.js';
import { openDatabase } from '../../src/memory/db.js';
import { getSignalWeights, setSignalWeights } from '../../src/memory/learning.js';
import { createPrediction } from '../../src/memory/predictions.js';
import { buildTradeSignal } from '../../src/technical/signals.js';
import type { TechnicalSnapshot } from '../../src/technical/types.js';

describe('technical signal learning consumption', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-technical-signals-'));
    process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');
    openDatabase();
  });

  afterEach(() => {
    if (process.env.THUFIR_DB_PATH) {
      rmSync(process.env.THUFIR_DB_PATH, { force: true });
      rmSync(dirname(process.env.THUFIR_DB_PATH), { recursive: true, force: true });
    }
    if (originalDbPath === undefined) {
      delete process.env.THUFIR_DB_PATH;
    } else {
      process.env.THUFIR_DB_PATH = originalDbPath;
    }
  });

  const config = {
    execution: { provider: 'hyperliquid' },
    technical: {
      onChain: { enabled: false },
      signals: {
        weights: {
          technical: 0.5,
          news: 0.3,
          onChain: 0.2,
        },
      },
    },
  } as const;

  const snapshot: TechnicalSnapshot = {
    symbol: 'BTC/USDT',
    timeframe: '1h',
    timestamp: Date.now(),
    price: 100,
    indicators: [
      { name: 'RSI', value: 70, signal: 'bullish', strength: 1 },
      { name: 'MACD', value: 1.2, signal: 'bullish', strength: 1 },
      { name: 'Bollinger', value: 0.8, signal: 'bullish', strength: 1 },
    ],
    overallBias: 'bullish',
    confidence: 0.8,
  };

  it('prefers perp learned weights over global and changes signal output', async () => {
    setSignalWeights('global', { technical: 0.1, news: 0.8, onChain: 0.1 });
    setSignalWeights('perp', { technical: 0.9, news: 0.05, onChain: 0.05 });

    const signal = await buildTradeSignal({
      config,
      snapshot,
      timeframe: snapshot.timeframe,
    });

    expect(signal.signalWeightsUsed).toEqual({
      technical: 0.9,
      news: 0.05,
      onChain: 0.05,
    });
    expect(signal.direction).toBe('long');
    expect(signal.confidence).toBeCloseTo(0.45, 6);
  });

  it('falls back to global learned weights when perp weights are absent', async () => {
    setSignalWeights('global', { technical: 0.1, news: 0.8, onChain: 0.1 });

    const signal = await buildTradeSignal({
      config,
      snapshot,
      timeframe: snapshot.timeframe,
    });

    expect(signal.signalWeightsUsed).toEqual({
      technical: 0.1,
      news: 0.8,
      onChain: 0.1,
    });
    expect(signal.direction).toBe('neutral');
    expect(signal.confidence).toBeCloseTo(0.05, 6);
  });

  it('learns from a recorded outcome artifact and uses it on the next signal', async () => {
    const baseline = await buildTradeSignal({
      config,
      snapshot,
      timeframe: snapshot.timeframe,
    });
    expect(baseline.signalWeightsUsed).toEqual({
      technical: 0.5,
      news: 0.3,
      onChain: 0.2,
    });

    const predictionId = createPrediction({
      marketId: 'perp:BTC',
      marketTitle: 'BTC learning artifact test',
      predictedOutcome: 'YES',
      predictedProbability: 0.7,
      modelProbability: 0.7,
      marketProbability: 0.45,
      domain: 'perp',
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

    recordOutcome({ id: predictionId, outcome: 'YES', outcomeBasis: 'final', pnl: 5 });

    const learned = getSignalWeights('perp');
    expect(learned).not.toBeNull();
    expect(learned!.technical).toBeGreaterThan(0.5);
    expect(learned!.news).toBeLessThan(0.3);
    expect(learned!.onChain).toBeLessThan(0.2);

    const after = await buildTradeSignal({
      config,
      snapshot,
      timeframe: snapshot.timeframe,
    });

    expect(after.signalWeightsUsed).toEqual(learned!);
    expect(after.confidence).toBeGreaterThan(baseline.confidence);
    expect(after.direction).toBe('long');
  });
});
