import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const marketFixtures = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const availability = vi.hoisted(() => ({ value: true }));

vi.mock('../../src/execution/market-client.js', () => ({
  createMarketClient: () => ({
    isAvailable: () => availability.value,
    listMarkets: async () => [],
    searchMarkets: async () => [],
    getMarket: async (marketId: string) => {
      const fixture = marketFixtures.get(marketId);
      if (!fixture) {
        throw new Error(`Missing fixture for ${marketId}`);
      }
      return fixture;
    },
  }),
}));

import { resolveOutcomes } from '../../src/core/resolver.js';
import { createPrediction, getPrediction } from '../../src/memory/predictions.js';

function useTempDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-delphi-resolver-'));
  process.env.THUFIR_DB_PATH = join(dir, 'thufir.sqlite');
}

describe('resolveOutcomes', () => {
  beforeEach(() => {
    marketFixtures.clear();
    availability.value = true;
    useTempDb();
  });

  it('resolves only predictions due at horizon cutoff with deterministic fixtures', async () => {
    const dueId = createPrediction({
      marketId: 'm-due',
      marketTitle: 'Due market',
      predictedOutcome: 'YES',
      predictedProbability: 0.62,
      horizonMinutes: 60,
      createdAt: '2026-02-17T00:00:00.000Z',
    });
    const futureId = createPrediction({
      marketId: 'm-future',
      marketTitle: 'Future market',
      predictedOutcome: 'NO',
      predictedProbability: 0.41,
      horizonMinutes: 120,
      createdAt: '2026-02-17T01:00:00.000Z',
    });

    marketFixtures.set('m-due', {
      id: 'm-due',
      question: 'Due',
      outcomes: ['YES', 'NO'],
      prices: { YES: 0.81, NO: 0.19 },
      platform: 'test',
    });
    marketFixtures.set('m-future', {
      id: 'm-future',
      question: 'Future',
      outcomes: ['YES', 'NO'],
      prices: { YES: 0.22, NO: 0.78 },
      platform: 'test',
    });

    const updated = await resolveOutcomes(
      {} as any,
      25,
      new Date('2026-02-17T01:30:00.000Z')
    );
    expect(updated).toBe(1);

    const due = getPrediction(dueId);
    const future = getPrediction(futureId);
    expect(due?.outcome).toBe('YES');
    expect(due?.resolutionStatus).toBe('resolved_true');
    expect(due?.resolutionMetadata?.basis).toBe('snapshot_threshold');
    expect(future?.resolutionStatus).toBe('open');
    expect(future?.outcome).toBeNull();
  });

  it('marks unresolved_error when snapshot outcome cannot be derived', async () => {
    const id = createPrediction({
      marketId: 'm-missing-price',
      marketTitle: 'Missing price market',
      predictedOutcome: 'YES',
      horizonMinutes: 30,
      createdAt: '2026-02-17T00:00:00.000Z',
    });

    marketFixtures.set('m-missing-price', {
      id: 'm-missing-price',
      question: 'No prices available',
      outcomes: ['YES', 'NO'],
      prices: {},
      platform: 'test',
    });

    const updated = await resolveOutcomes(
      {} as any,
      25,
      new Date('2026-02-17T01:00:00.000Z')
    );
    expect(updated).toBe(1);

    const prediction = getPrediction(id);
    expect(prediction?.resolutionStatus).toBe('unresolved_error');
    expect(prediction?.outcome).toBeNull();
    expect(prediction?.resolutionError).toContain('snapshot outcome');
  });
});
