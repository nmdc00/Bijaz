import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/memory/perp_trades.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/memory/perp_trades.js')>(
    '../../src/memory/perp_trades.js'
  );
  return {
    ...actual,
    clearActivePerpPositionLifecycle: () => {
      throw new Error('attempt to write a readonly database');
    },
    getActivePerpPositionTradeId: () => {
      throw new Error('attempt to write a readonly database');
    },
    recordPerpTrade: () => {
      throw new Error('attempt to write a readonly database');
    },
    setActivePerpPositionLifecycle: () => {
      throw new Error('attempt to write a readonly database');
    },
  };
});

describe('tool-executor perp lifecycle fallback', () => {
  it('does not fail a successful order when lifecycle persistence is unavailable', async () => {
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
      { symbol: 'BTC', side: 'buy', size: 1, signal_class: 'mean_reversion', trade_archetype: 'intraday' },
      {
        config: { execution: { provider: 'hyperliquid' } } as any,
        marketClient,
        executor,
        limiter,
      }
    );

    expect(res.success).toBe(true);
    expect((res as any).data.mode).toBe('paper');
  });
});
