import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/autonomy_policy.js', () => ({
  evaluateGlobalTradeGate: () => ({
    allowed: false,
    reason: 'observation-only mode active until 2099-01-01T00:00:00.000Z',
    policyState: {
      minEdgeOverride: null,
      maxTradesPerScanOverride: null,
      leverageCapOverride: null,
      observationOnlyUntilMs: Date.now() + 10_000,
      reason: 'test',
      updatedAt: new Date().toISOString(),
    },
  }),
}));

describe('tool-executor policy gate', () => {
  it('blocks perp_place_order when global policy gate denies execution', async () => {
    const { executeToolCall } = await import('../../src/core/tool-executor.js');

    const marketClient = {
      getMarket: async (symbol: string) => ({
        id: symbol,
        question: `Perp: ${symbol}`,
        outcomes: ['LONG', 'SHORT'],
        prices: {},
        platform: 'hyperliquid',
        kind: 'perp',
        symbol,
        markPrice: 50000,
        metadata: { maxLeverage: 10 },
      }),
      listMarkets: async () => [],
      searchMarkets: async () => [],
    };
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };

    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.01, signal_class: 'mean_reversion', trade_archetype: 'intraday' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );

    expect(res.success).toBe(false);
    expect(String((res as any).error)).toMatch(/observation-only mode active/i);
  });
});
