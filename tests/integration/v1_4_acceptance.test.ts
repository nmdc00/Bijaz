import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import fixture from '../fixtures/v1_4_acceptance.fixture.json';

vi.mock('../../src/execution/market-client.js', () => ({
  createMarketClient: vi.fn(() => ({
    isAvailable: () => true,
    getMarket: async (marketId: string) => ({
      id: marketId,
      resolved: true,
      resolution: marketId.includes('yes') ? 'YES' : 'NO',
    }),
  })),
}));

type Session = 'asia' | 'europe_open' | 'us_open' | 'us_midday' | 'us_close' | 'weekend';
type LiquidityRegime = 'thin' | 'normal' | 'deep';

interface SessionFixture {
  iso: string;
  expectedSession: Session;
  expectedLiquidityRegime: LiquidityRegime;
  expectedSessionWeight: number;
}

const previousDbPath = process.env.THUFIR_DB_PATH;

function setIsolatedDbPath(name: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-v14-acceptance-'));
  process.env.THUFIR_DB_PATH = join(dir, `${name}.sqlite`);
}

function classifySessionReference(iso: string): {
  session: Session;
  liquidityRegime: LiquidityRegime;
  sessionWeight: number;
  qualityNotes: string;
} {
  const date = new Date(iso);
  const utcDay = date.getUTCDay();
  const utcHour = date.getUTCHours();

  if (utcDay === 0 || utcDay === 6) {
    return {
      session: 'weekend',
      liquidityRegime: 'thin',
      sessionWeight: 0.65,
      qualityNotes: 'Weekend flow is thin; favor conservative confidence.',
    };
  }

  if (utcHour < 6) {
    return {
      session: 'asia',
      liquidityRegime: 'normal',
      sessionWeight: 0.85,
      qualityNotes: 'Asia session: thinner momentum follow-through.',
    };
  }

  if (utcHour < 12) {
    return {
      session: 'europe_open',
      liquidityRegime: 'deep',
      sessionWeight: 1.0,
      qualityNotes: 'Europe open: cleaner trend discovery.',
    };
  }

  if (utcHour < 17) {
    return {
      session: 'us_open',
      liquidityRegime: 'deep',
      sessionWeight: 1.05,
      qualityNotes: 'US open: highest volatility and participation.',
    };
  }

  if (utcHour < 20) {
    return {
      session: 'us_midday',
      liquidityRegime: 'normal',
      sessionWeight: 0.95,
      qualityNotes: 'US midday: mean-reversion risk increases.',
    };
  }

  return {
    session: 'us_close',
    liquidityRegime: 'normal',
    sessionWeight: 0.9,
    qualityNotes: 'US close: late-day flow can be noisy.',
  };
}

async function seedDomainOutcomes(params: {
  domain: string;
  count: number;
  predictedProbability: number;
  predictedOutcome: 'YES' | 'NO';
  resolvedOutcome: 'YES' | 'NO';
}): Promise<void> {
  const { createPrediction } = await import('../../src/memory/predictions.js');
  const { recordOutcome } = await import('../../src/memory/calibration.js');

  for (let i = 0; i < params.count; i += 1) {
    const id = createPrediction({
      marketId: `${params.domain}-market-${i}`,
      marketTitle: `Fixture market ${i}`,
      predictedOutcome: params.predictedOutcome,
      predictedProbability: params.predictedProbability,
      domain: params.domain,
    });
    recordOutcome({ id, outcome: params.resolvedOutcome });
  }
}

afterEach(() => {
  process.env.THUFIR_DB_PATH = previousDbPath;
});

describe('v1.4 acceptance harness', () => {
  it('keeps deterministic session fixtures and reference session mapping', () => {
    const sessionCases = fixture.sessionCases as SessionFixture[];
    expect(sessionCases.length).toBeGreaterThanOrEqual(6);

    for (const entry of sessionCases) {
      const result = classifySessionReference(entry.iso);
      expect(result.session).toBe(entry.expectedSession);
      expect(result.liquidityRegime).toBe(entry.expectedLiquidityRegime);
      expect(result.sessionWeight).toBeCloseTo(entry.expectedSessionWeight, 6);
      expect(result.qualityNotes.length).toBeGreaterThan(10);
    }
  });

  it('validates prediction lifecycle fixture through storage and resolution hooks', async () => {
    setIsolatedDbPath('lifecycle');

    const { createPrediction, getPrediction } = await import('../../src/memory/predictions.js');
    const { resolveOutcomes } = await import('../../src/core/resolver.js');

    const lifecycle = fixture.predictionLifecycle;
    const ids: string[] = [];
    for (const spec of lifecycle.cases) {
      ids.push(
        createPrediction({
          marketId: spec.marketId,
          marketTitle: spec.marketTitle,
          predictedOutcome: spec.predictedOutcome as 'YES' | 'NO',
          predictedProbability: spec.predictedProbability,
          domain: lifecycle.domain,
          expiresAt: '2026-01-01T00:00:00.000Z',
        })
      );
    }

    const updated = await resolveOutcomes({} as never, 50);
    expect(updated).toBe(lifecycle.cases.length);

    for (const id of ids) {
      const row = getPrediction(id);
      expect(row).not.toBeNull();
      expect(row?.outcome === 'YES' || row?.outcome === 'NO').toBe(true);
      expect(row?.outcomeTimestamp).toBeTruthy();
    }
  });

  it('enforces calibration-aware risk sizing in decision prompts', async () => {
    const { buildDecisionPrompts } = await import('../../src/core/decision.js');

    setIsolatedDbPath('calibration-poor');
    await seedDomainOutcomes({
      domain: 'crypto',
      count: 10,
      predictedProbability: 0.9,
      predictedOutcome: 'YES',
      resolvedOutcome: 'NO',
    });

    const poor = buildDecisionPrompts(
      {
        id: 'market-a',
        question: 'BTC up tomorrow?',
        outcomes: ['YES', 'NO'],
        prices: [0.5, 0.5],
        category: 'crypto',
        volume: 100000,
        liquidity: 50000,
      } as never,
      100
    );

    setIsolatedDbPath('calibration-good');
    await seedDomainOutcomes({
      domain: 'crypto',
      count: 10,
      predictedProbability: 0.9,
      predictedOutcome: 'YES',
      resolvedOutcome: 'YES',
    });

    const good = buildDecisionPrompts(
      {
        id: 'market-b',
        question: 'BTC up tomorrow?',
        outcomes: ['YES', 'NO'],
        prices: [0.5, 0.5],
        category: 'crypto',
        volume: 100000,
        liquidity: 50000,
      } as never,
      100
    );

    expect(poor.positionSuggestion.suggested).toBeLessThan(good.positionSuggestion.suggested);
    expect(poor.positionSuggestion.reasoning).toContain('minimal');
  });

  it('verifies schema migration bootstrap for v1.4 acceptance DB', () => {
    const schemaSql = readFileSync('src/memory/schema.sql', 'utf8');
    const db = new Database(':memory:');

    db.exec(schemaSql);

    const requiredTables = [
      'predictions',
      'calibration_cache',
      'trades',
      'learning_events',
      'market_cache',
    ];

    for (const table of requiredTables) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table) as { name?: string } | undefined;
      expect(row?.name).toBe(table);
    }

    const predictionColumns = db
      .prepare('PRAGMA table_info(predictions)')
      .all() as Array<{ name: string }>;
    const columnNames = predictionColumns.map((col) => col.name);
    expect(columnNames).toContain('predicted_probability');
    expect(columnNames).toContain('outcome');
    expect(columnNames).toContain('brier_contribution');
  });
});
