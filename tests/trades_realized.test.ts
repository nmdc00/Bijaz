import { describe, it, expect } from 'vitest';

import { computeRealizedPnl } from '../src/memory/trades.js';

describe('trade ledger realized PnL', () => {
  it('computes FIFO realized PnL', () => {
    const trades = [
      {
        id: 1,
        predictionId: 'p1',
        marketId: 'm1',
        marketTitle: 'Test',
        outcome: 'YES' as const,
        side: 'buy' as const,
        price: 0.4,
        amount: 40,
        shares: 100,
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 2,
        predictionId: 'p1',
        marketId: 'm1',
        marketTitle: 'Test',
        outcome: 'YES' as const,
        side: 'sell' as const,
        price: 0.6,
        amount: 30,
        shares: 50,
        createdAt: '2024-01-02T00:00:00Z',
      },
    ];

    const realized = computeRealizedPnl(trades);
    expect(realized).toBeCloseTo(10, 6);
  });
});
