import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeToolCall } from '../../src/core/tool-executor.js';
import { HyperliquidClient } from '../../src/execution/hyperliquid/client.js';

describe('tool-executor perps', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-tool-executor-perps-'));
    process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      { symbol: 'BTC', side: 'buy', size: 1, trade_archetype: 'intraday' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('retries no-immediate-match failures with widened slippage and succeeds', async () => {
    const slippageSeen: number[] = [];
    let confirmCount = 0;
    let releaseCount = 0;
    const executor = {
      execute: async (_market: unknown, decision: { marketSlippageBps?: number }) => {
        slippageSeen.push(Number(decision.marketSlippageBps ?? -1));
        if (slippageSeen.length < 3) {
          return {
            executed: false,
            message:
              'Hyperliquid trade failed: Order 0: Order could not immediately match against any resting orders. asset=0',
          };
        }
        return { executed: true, message: 'Hyperliquid order filled (oid=1).' };
      },
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {
        confirmCount += 1;
      },
      release: () => {
        releaseCount += 1;
      },
    };

    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 1 },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          hyperliquid: { defaultSlippageBps: 10 },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );

    expect(res.success).toBe(true);
    expect(slippageSeen).toEqual([10, 35, 60]);
    expect(confirmCount).toBe(1);
    expect(releaseCount).toBe(0);
    if (res.success) {
      const data = res.data as { execution_attempts?: Array<{ attempt: number }> };
      expect(data.execution_attempts?.length).toBe(3);
    }
  });

  it('autofills missing entry contract fields when trade-contract enforcement is enabled', async () => {
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
      { symbol: 'BTC', side: 'buy', size: 0.001 },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          autonomy: { tradeContract: { enabled: true } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(true);
  });

  it('accepts entry orders with a valid contract when enforcement is enabled', async () => {
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
    const nowMs = Date.now();
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTC',
        side: 'buy',
        size: 0.01,
        trade_archetype: 'intraday',
        invalidation_type: 'price_level',
        invalidation_price: 49000,
        time_stop_at_ms: nowMs + 2 * 60 * 60 * 1000,
        take_profit_r: 2,
        trail_mode: 'structure',
      },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          autonomy: { tradeContract: { enabled: true } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
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
      { symbol: 'BTC', side: 'buy', size: 1, leverage: 7, trade_archetype: 'intraday' },
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
      { symbol: 'BTC', side: 'buy', size: 1, trade_archetype: 'intraday' },
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
      { symbol: 'BTC', side: 'sell', size: 1, reduce_only: true, exit_mode: 'risk_reduction' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('accepts deterministic thesis evaluation fields for reduce-only exits', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getClearinghouseState').mockResolvedValue({
      assetPositions: [{ position: { coin: 'XBTTEST', szi: '0.005' } }],
    } as any);
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

  it('allows non-reduce-only orders without a trade archetype when contract enforcement is not enabled', async () => {
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
      { symbol: 'BTC', side: 'buy', size: 0.01 },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('blocks conflicting thesis invalidation fields for reduce-only exits', async () => {
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
      {
        symbol: 'BTC',
        side: 'sell',
        size: 0.01,
        reduce_only: true,
        thesis_invalidation_hit: true,
        exit_mode: 'risk_reduction',
      },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(false);
    expect(String((res as any).error)).toContain('conflicts');
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
        trade_archetype: 'intraday',
        entry_trigger: 'news',
        news_subtype: 'macro',
        news_sources: sources,
      },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('persists plan_context metadata in perp trade journal entries', async () => {
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
    const symbol = 'PLANTESTBTC';
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol,
        side: 'buy',
        size: 0.001,
        plan_context: {
          plan_id: 'plan-abc',
          current_step_id: 'step-1',
          plan_revision_count: 2,
        },
      },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);

    const listRes = await executeToolCall(
      'perp_trade_journal_list',
      { symbol, limit: 5 },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient }
    );
    expect(listRes.success).toBe(true);
    const entries = ((listRes as any).data?.entries ?? []) as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.planContext).toMatchObject({
      plan_id: 'plan-abc',
      current_step_id: 'step-1',
      plan_revision_count: 2,
    });
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
