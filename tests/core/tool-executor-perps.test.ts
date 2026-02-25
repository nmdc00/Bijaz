import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeToolCall } from '../../src/core/tool-executor.js';
import { HyperliquidClient } from '../../src/execution/hyperliquid/client.js';
import { PaperExecutor } from '../../src/execution/modes/paper.js';

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
      { symbol: 'BTC', side: 'buy', size: 1 },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('verifies paper reduce-only closes with explicit postcondition metadata', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };

    const openRes = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.1, mode: 'paper' },
      { config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any, marketClient, executor, limiter }
    );
    expect(openRes.success).toBe(true);

    const closeRes = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'sell', size: 0.1, reduce_only: true, mode: 'paper' },
      { config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any, marketClient, executor, limiter }
    );
    expect(closeRes.success).toBe(true);
    if (closeRes.success) {
      const post = (closeRes.data as { reduce_only_postcondition?: Record<string, unknown> })
        .reduce_only_postcondition;
      expect(post).toBeTruthy();
      expect(post?.verified).toBe(true);
      expect(post?.close_complete).toBe(true);
      expect(post?.after_size).toBe(0);
    }
  });

  it('reuses one tradeId across a full paper position lifecycle', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
      marketClient,
      executor,
      limiter,
    };
    const symbol = 'BTCLIFE';

    const openRes = await executeToolCall(
      'perp_place_order',
      { symbol, side: 'buy', size: 0.05, mode: 'paper' },
      ctx
    );
    expect(openRes.success).toBe(true);

    const addRes = await executeToolCall(
      'perp_place_order',
      { symbol, side: 'buy', size: 0.02, mode: 'paper' },
      ctx
    );
    expect(addRes.success).toBe(true);

    const cutRes = await executeToolCall(
      'perp_place_order',
      { symbol, side: 'sell', size: 0.03, reduce_only: true, mode: 'paper' },
      ctx
    );
    expect(cutRes.success).toBe(true);

    const closeRes = await executeToolCall(
      'perp_place_order',
      { symbol, side: 'sell', size: 0.04, reduce_only: true, mode: 'paper' },
      ctx
    );
    expect(closeRes.success).toBe(true);

    const listRes = await executeToolCall(
      'perp_trade_journal_list',
      { symbol, limit: 20 },
      { config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any, marketClient }
    );
    expect(listRes.success).toBe(true);
    const entries = (((listRes as any).data?.entries ?? []) as Array<Record<string, unknown>>)
      .filter((entry) => entry.outcome === 'executed')
      .slice(0, 4);
    expect(entries.length).toBe(4);
    const tradeIds = entries
      .map((entry) => Number(entry.tradeId ?? NaN))
      .filter((tradeId) => Number.isFinite(tradeId) && tradeId > 0);
    expect(tradeIds.length).toBe(4);
    expect(new Set(tradeIds).size).toBe(1);
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
      { symbol: 'BTC', side: 'sell', size: 1, reduce_only: true, mode: 'live' },
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

  it('blocks reduce-only when no live position exists', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getClearinghouseState').mockResolvedValue({
      assetPositions: [],
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
    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'sell', size: 1, reduce_only: true, mode: 'live' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('no open BTC position');
  });

  it('blocks reduce-only when side would increase current position', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getClearinghouseState').mockResolvedValue({
      assetPositions: [{ position: { coin: 'BTC', szi: '0.4' } }],
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
    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.1, reduce_only: true, mode: 'live' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('would increase current long BTC position');
  });

  it('caps reduce-only size to live position size before execution', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getClearinghouseState').mockResolvedValue({
      assetPositions: [{ position: { coin: 'BTC', szi: '0.25' } }],
    } as any);
    let executedSize = 0;
    const executor = {
      execute: async (_market: unknown, decision: { size?: number }) => {
        executedSize = Number(decision.size ?? 0);
        return { executed: true, message: 'ok' };
      },
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
      { symbol: 'BTC', side: 'sell', size: 0.8, reduce_only: true, mode: 'live' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
    expect(executedSize).toBeCloseTo(0.25, 8);
  });

  it('blocks manual reduce-only exits when exit FSM enforcement is enabled', async () => {
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
        symbol: 'XBTTEST',
        side: 'sell',
        size: 0.001,
        reduce_only: true,
        exit_mode: 'manual',
        thesis_invalidation_hit: false,
      },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          autonomy: { tradeContract: { enforceExitFsm: true } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/manual\/unknown reduce-only exits are blocked/i);
  });

  it('allows manual reduce-only exits with emergency override under FSM enforcement', async () => {
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
        symbol: 'XBTTEST',
        side: 'sell',
        size: 0.001,
        reduce_only: true,
        exit_mode: 'manual',
        emergency_override: true,
        emergency_reason: 'Exchange-side stop desynced after outage',
      },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          autonomy: { tradeContract: { enforceExitFsm: true } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(true);
  });

  it('normalizes missing reduce-only exit_mode when exit FSM enforcement is enabled', async () => {
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
        symbol: 'XBTTEST',
        side: 'sell',
        size: 0.001,
        reduce_only: true,
      },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          autonomy: { tradeContract: { enforceExitFsm: true } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(true);
  });

  it('normalizes conflicting reduce-only invalidation fields when exit FSM enforcement is enabled', async () => {
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
        symbol: 'XBTTEST',
        side: 'sell',
        size: 0.001,
        reduce_only: true,
        exit_mode: 'take_profit',
        thesis_invalidation_hit: true,
      },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          autonomy: { tradeContract: { enforceExitFsm: true } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(true);
  });

  it('persists deterministic direction/timing/sizing/exit scores for closed trades', async () => {
    let markPrice = 100;
    const dynamicMarketClient = {
      getMarket: async (symbol: string) => ({
        id: symbol,
        question: `Perp: ${symbol}`,
        outcomes: ['LONG', 'SHORT'],
        prices: {},
        platform: 'hyperliquid',
        kind: 'perp',
        symbol,
        markPrice,
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

    const symbol = 'SCORETESTBTC';
    const hypothesisId = 'hyp_component_scoring_test';
    const entryRes = await executeToolCall(
      'perp_place_order',
      {
        symbol,
        side: 'buy',
        size: 0.4,
        expected_edge: 0.6,
        hypothesis_id: hypothesisId,
      },
      {
        config: { execution: { provider: 'hyperliquid' } } as any,
        marketClient: dynamicMarketClient as any,
        executor,
        limiter,
      }
    );
    expect(entryRes.success).toBe(true);

    markPrice = 110;
    const closeRes = await executeToolCall(
      'perp_place_order',
      {
        symbol,
        side: 'sell',
        size: 0.4,
        reduce_only: true,
        hypothesis_id: hypothesisId,
        thesis_invalidation_hit: false,
        exit_mode: 'take_profit',
        price_path_high: 120,
        price_path_low: 90,
      },
      {
        config: { execution: { provider: 'hyperliquid' } } as any,
        marketClient: dynamicMarketClient as any,
        executor,
        limiter,
      }
    );
    expect(closeRes.success).toBe(true);

    const listRes = await executeToolCall(
      'perp_trade_journal_list',
      { symbol, limit: 20 },
      {
        config: { execution: { provider: 'hyperliquid' } } as any,
        marketClient: dynamicMarketClient as any,
      }
    );
    expect(listRes.success).toBe(true);
    const entries = ((listRes as any).data?.entries ?? []) as Array<Record<string, unknown>>;
    const closed = entries.find(
      (entry) =>
        entry.hypothesisId === hypothesisId &&
        entry.reduceOnly === true &&
        entry.outcome === 'executed'
    );
    expect(closed).toBeDefined();
    expect(Number(closed?.directionScore)).toBe(1);
    expect(Number(closed?.timingScore)).toBeCloseTo(2 / 3, 8);
    expect(Number(closed?.sizingScore)).toBeCloseTo(0.6857142857, 8);
    expect(Number(closed?.exitScore)).toBeCloseTo(0.5, 8);
    expect(Number(closed?.direction_score)).toBe(1);
    expect(Number(closed?.timing_score)).toBeCloseTo(2 / 3, 8);
    expect(Number(closed?.sizing_score)).toBeCloseTo(0.6857142857, 8);
    expect(Number(closed?.exit_score)).toBeCloseTo(0.5, 8);
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

  it('tracks paper open orders and positions with 200 USDC default bankroll', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: { execution: { mode: 'paper', provider: 'hyperliquid' } } as any,
      marketClient,
      executor,
      limiter,
    };

    const placeLimit = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.01, order_type: 'limit', price: 49000 },
      ctx
    );
    expect(placeLimit.success).toBe(true);

    const openOrders = await executeToolCall('perp_open_orders', {}, ctx);
    expect(openOrders.success).toBe(true);
    const orders = ((openOrders as any).data?.orders ?? []) as Array<Record<string, unknown>>;
    expect(orders.length).toBeGreaterThan(0);
    const orderId = String(orders[0]?.id ?? '');
    expect(orderId.length).toBeGreaterThan(0);

    const cancel = await executeToolCall('perp_cancel_order', { order_id: orderId }, ctx);
    expect(cancel.success).toBe(true);

    const placeMarket = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.005, order_type: 'market' },
      ctx
    );
    expect(placeMarket.success).toBe(true);

    const positions = await executeToolCall('perp_positions', {}, ctx);
    expect(positions.success).toBe(true);
    const perpPositions = ((positions as any).data?.positions ?? []) as Array<Record<string, unknown>>;
    expect(perpPositions.length).toBeGreaterThan(0);
    expect(typeof perpPositions[0]?.mark_price).toBe('number');
    expect(typeof perpPositions[0]?.unrealized_pnl).toBe('number');

    const portfolio = await executeToolCall('get_portfolio', {}, ctx);
    expect(portfolio.success).toBe(true);
    expect((portfolio as any).data?.summary?.perp_mode).toBe('paper');
    expect((portfolio as any).data?.perp_summary?.source).toBe('paper');
    expect(((portfolio as any).data?.perp_positions ?? []).length).toBeGreaterThan(0);
    expect(typeof (portfolio as any).data?.perp_summary?.total_unrealized_pnl).toBe('number');
    expect(Number((portfolio as any).data?.perp_summary?.account_value)).toBeCloseTo(
      Number((portfolio as any).data?.perp_summary?.withdrawable) +
        Number((portfolio as any).data?.perp_summary?.total_unrealized_pnl),
      8
    );
    expect(Number((portfolio as any).data?.summary?.available_balance)).toBeGreaterThan(0);
  });

  it('paper_promotion_report returns gate evaluation', async () => {
    const symbol = 'GATETEST';
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
    for (const side of ['buy', 'buy', 'sell', 'sell'] as const) {
      await executeToolCall(
        'perp_place_order',
        {
          symbol,
          side,
          size: 0.001,
          signal_class: 'breakout_15m',
          thesis_invalidation_hit: side === 'sell',
          exit_mode: side === 'sell' ? 'take_profit' : undefined,
          reduce_only: side === 'sell',
        },
        { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
      );
    }

    const res = await executeToolCall(
      'paper_promotion_report',
      { symbol, signal_class: 'breakout_15m' },
      {
        config: { execution: { provider: 'hyperliquid' }, paper: { promotionGates: { minTrades: 1 } } } as any,
        marketClient,
      }
    );
    expect(res.success).toBe(true);
    if (res.success) {
      expect((res.data as any).setupKey).toBe(`${symbol}:breakout_15m`);
      expect((res.data as any).sampleCount).toBeGreaterThanOrEqual(1);
    }
  });
});
