import { describe, it, expect } from 'vitest';

import { executeToolCall } from '../../src/core/tool-executor.js';

describe('tool-executor perps', () => {
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

  it('perp_place_order routes to executor', async () => {
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
      { symbol: 'BTC', side: 'buy', size: 1 },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('perp_place_order blocks leverage above risk max', async () => {
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
      { symbol: 'BTC', side: 'buy', size: 1, leverage: 7 },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          wallet: { perps: { maxLeverage: 5 } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/Leverage/i);
  });

  it('perp_place_order blocks oversized notional', async () => {
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
      { symbol: 'BTC', side: 'buy', size: 1 },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          wallet: { perps: { maxOrderNotionalUsd: 1000 } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/notional/i);
  });

  it('perp_place_order allows reduce-only even if spending limiter blocks', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: false, reason: 'nope' }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'sell', size: 1, reduce_only: true },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('accepts deterministic thesis evaluation fields for reduce-only exits', async () => {
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
    const symbol = 'XBTTEST';
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol,
        side: 'sell',
        size: 0.001,
        reduce_only: true,
        hypothesis_id: 'hyp_test_close',
        thesis_invalidation_hit: false,
        exit_mode: 'manual',
      },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('accepts news provenance metadata on news-triggered entries', async () => {
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
    const symbol = 'ETHTEST';
    const sources = ['https://example.com/news/a', 'intel:news:1234'];
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol,
        side: 'buy',
        size: 0.001,
        entry_trigger: 'news',
        news_subtype: 'macro',
        news_sources: sources,
      },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('perp_open_orders returns executor orders', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [{ id: '1' }],
      cancelOrder: async () => {},
    };
    const res = await executeToolCall(
      'perp_open_orders',
      {},
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor }
    );
    expect(res.success).toBe(true);
  });

  it('perp_cancel_order calls executor cancel', async () => {
    let called = false;
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {
        called = true;
      },
    };
    const res = await executeToolCall(
      'perp_cancel_order',
      { order_id: '123' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor }
    );
    expect(res.success).toBe(true);
    expect(called).toBe(true);
  });
});
