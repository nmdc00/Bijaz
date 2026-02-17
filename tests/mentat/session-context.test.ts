import { describe, expect, it } from 'vitest';

import type { Market } from '../../src/execution/markets.js';
import { deriveSessionContext } from '../../src/mentat/session-context.js';

function mkMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: overrides.id ?? 'm-1',
    question: overrides.question ?? 'Will BTC close green this week?',
    outcomes: overrides.outcomes ?? ['Yes', 'No'],
    prices: overrides.prices ?? { Yes: 0.52, No: 0.48 },
    platform: overrides.platform ?? 'test',
    volume: overrides.volume,
    liquidity: overrides.liquidity,
    category: overrides.category ?? 'crypto',
  };
}

describe('deriveSessionContext', () => {
  it.each([
    {
      at: '2026-02-13T23:59:59Z',
      expectedSession: 'offhours',
      expectedRegime: 'thin',
    },
    {
      at: '2026-02-14T00:00:00Z',
      expectedSession: 'weekend',
      expectedRegime: 'thin',
    },
    {
      at: '2026-02-15T12:00:00Z',
      expectedSession: 'weekend',
      expectedRegime: 'thin',
    },
    {
      at: '2026-02-16T00:00:00Z',
      expectedSession: 'asia',
      expectedRegime: 'normal',
    },
    {
      at: '2026-02-16T08:00:00Z',
      expectedSession: 'europe',
      expectedRegime: 'normal',
    },
    {
      at: '2026-02-16T13:00:00Z',
      expectedSession: 'us',
      expectedRegime: 'normal',
    },
  ])('classifies UTC session boundaries ($at)', ({ at, expectedSession, expectedRegime }) => {
    const context = deriveSessionContext({ at, markets: [] });
    expect(context.session).toBe(expectedSession);
    expect(context.liquidityRegime).toBe(expectedRegime);
    expect(context.qualityNotes.length).toBeGreaterThan(0);
    expect(context.sessionWeight).toBeGreaterThanOrEqual(0.4);
    expect(context.sessionWeight).toBeLessThanOrEqual(1);
  });

  it('uses market metadata to classify deep regime during liquid weekday conditions', () => {
    const context = deriveSessionContext({
      at: '2026-02-16T14:00:00Z',
      markets: [
        mkMarket({ id: 'm-1', volume: 600_000, liquidity: 500_000 }),
        mkMarket({ id: 'm-2', volume: 450_000, liquidity: 350_000 }),
      ],
    });

    expect(context.session).toBe('us');
    expect(context.liquidityRegime).toBe('deep');
    expect(context.sessionWeight).toBe(1);
  });

  it('uses market metadata to classify thin regime during weekday conditions', () => {
    const context = deriveSessionContext({
      at: '2026-02-16T10:00:00Z',
      markets: [
        mkMarket({ id: 'm-1', volume: 40_000, liquidity: 8_000 }),
        mkMarket({ id: 'm-2', volume: 25_000, liquidity: 5_000 }),
      ],
    });

    expect(context.session).toBe('europe');
    expect(context.liquidityRegime).toBe('thin');
    expect(context.sessionWeight).toBeLessThan(0.9);
  });

  it('forces weekend session to thin regardless of market metadata', () => {
    const context = deriveSessionContext({
      at: '2026-02-15T18:00:00Z',
      markets: [mkMarket({ volume: 900_000, liquidity: 700_000 })],
    });

    expect(context.session).toBe('weekend');
    expect(context.liquidityRegime).toBe('thin');
    expect(context.qualityNotes.some((note) => note.toLowerCase().includes('weekend'))).toBe(true);
  });
});
