import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/memory/autonomy_policy_state.js', () => ({
  getAutonomyPolicyState: vi.fn(() => ({
    minEdgeOverride: null,
    maxTradesPerScanOverride: null,
    leverageCapOverride: null,
    observationOnlyUntilMs: null,
    reason: null,
    updatedAt: new Date(0).toISOString(),
  })),
  upsertAutonomyPolicyState: vi.fn(),
}));

vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  listPerpTradeJournals: vi.fn(() => []),
}));

vi.mock('../../src/core/signal_performance.js', () => ({
  summarizeSignalPerformance: vi.fn(() => ({
    sampleCount: 0,
    sharpeLike: 10,
    expectancy: 0.2,
    variance: 1,
  })),
}));

vi.mock('../../src/core/daily_pnl.js', () => ({
  getDailyPnLRollup: vi.fn(),
}));

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ c: 0 })),
    })),
  })),
}));

import { evaluateGlobalTradeGate } from '../../src/core/autonomy_policy.js';
import { getDailyPnLRollup } from '../../src/core/daily_pnl.js';

describe('evaluateGlobalTradeGate drawdown cap', () => {
  beforeEach(() => {
    vi.mocked(getDailyPnLRollup).mockReturnValue({
      date: '2026-02-17',
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      byDomain: [],
    });
  });

  it('allows trading when realized P&L is above drawdown threshold', () => {
    vi.mocked(getDailyPnLRollup).mockReturnValue({
      date: '2026-02-17',
      realizedPnl: -99,
      unrealizedPnl: 0,
      totalPnl: -99,
      byDomain: [],
    });

    const result = evaluateGlobalTradeGate(
      {
        autonomy: {
          enabled: true,
          fullAuto: true,
          dailyDrawdownCapUsd: 100,
          maxTradesPerDay: 25,
        },
      } as any,
      { expectedEdge: 0.08 }
    );

    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBeUndefined();
  });

  it('blocks trading when realized P&L reaches drawdown threshold', () => {
    vi.mocked(getDailyPnLRollup).mockReturnValue({
      date: '2026-02-17',
      realizedPnl: -100,
      unrealizedPnl: 0,
      totalPnl: -100,
      byDomain: [],
    });

    const result = evaluateGlobalTradeGate(
      {
        autonomy: {
          enabled: true,
          fullAuto: true,
          dailyDrawdownCapUsd: 100,
          maxTradesPerDay: 25,
        },
      } as any,
      { expectedEdge: 0.08 }
    );

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('policy.daily_drawdown_cap');
    expect(result.reason).toMatch(/drawdown cap/i);
  });

  it('blocks trading when realized P&L exceeds drawdown threshold', () => {
    vi.mocked(getDailyPnLRollup).mockReturnValue({
      date: '2026-02-17',
      realizedPnl: -101,
      unrealizedPnl: 0,
      totalPnl: -101,
      byDomain: [],
    });

    const result = evaluateGlobalTradeGate(
      {
        autonomy: {
          enabled: true,
          fullAuto: true,
          dailyDrawdownCapUsd: 100,
          maxTradesPerDay: 25,
        },
      } as any,
      { expectedEdge: 0.2 }
    );

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('policy.daily_drawdown_cap');
  });
});
