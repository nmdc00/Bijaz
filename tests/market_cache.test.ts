import { describe, it, expect, beforeEach, vi } from 'vitest';

type CacheRow = {
  id: string;
  question: string;
  outcomes?: string | null;
  prices?: string | null;
  updatedAt?: string | null;
};

const state = vi.hoisted(() => ({
  rows: new Map<string, CacheRow>(),
}));

vi.mock('../src/memory/db.js', () => {
  return {
    openDatabase: () => ({
      prepare: (sql: string) => {
        if (sql.includes('INSERT INTO market_cache')) {
          return {
            run: (params: Record<string, unknown>) => {
              state.rows.set(String(params.id), {
                id: String(params.id),
                question: String(params.question),
                outcomes: (params.outcomes as string | null) ?? null,
                prices: (params.prices as string | null) ?? null,
                updatedAt: new Date().toISOString(),
              });
              return {};
            },
          };
        }
        if (sql.includes('FROM market_cache') && sql.includes('WHERE id = ?')) {
          return {
            get: (id: string) => {
              const row = state.rows.get(String(id));
              if (!row) return undefined;
              return {
                id: row.id,
                question: row.question,
                outcomes: row.outcomes,
                prices: row.prices,
                endDate: null,
                category: null,
                resolved: 0,
                resolution: null,
                createdAt: null,
                updatedAt: row.updatedAt,
              };
            },
          };
        }
        return {
          get: () => undefined,
          run: () => ({}),
        };
      },
      exec: () => undefined,
      pragma: () => undefined,
    }),
  };
});

import { getMarketCache, upsertMarketCache } from '../src/memory/market_cache.js';

describe('market cache', () => {
  beforeEach(() => {
    state.rows.clear();
  });

  it('upserts and reads cached markets', () => {
    upsertMarketCache({
      id: 'm1',
      question: 'Test market',
      outcomes: ['YES', 'NO'],
      prices: { YES: 0.42, NO: 0.58 },
    });

    const cached = getMarketCache('m1');
    expect(cached?.question).toBe('Test market');
    expect(cached?.outcomes).toEqual(['YES', 'NO']);
    expect(cached?.prices).toEqual({ YES: 0.42, NO: 0.58 });
  });
});
