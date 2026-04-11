/**
 * Tests that close (reduce-only) journal entries inherit signalClass from the
 * matching entry journal record when the LLM does not supply signal_class in
 * the close call.  Before the fix, signalClass was always null on close entries
 * causing signal performance stats to show 0% win rate for every signal class.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const recordPerpTradeJournalMock = vi.fn();
const listPerpTradeJournalsMock = vi.fn(() => []);

vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  recordPerpTradeJournal: (...args: unknown[]) => recordPerpTradeJournalMock(...args),
  listPerpTradeJournals: (...args: unknown[]) => listPerpTradeJournalsMock(...args),
}));

vi.mock('../../src/memory/perp_trades.js', () => ({
  recordPerpTrade: vi.fn(() => 42),
  getActivePerpPositionTradeId: vi.fn(() => null),
  setActivePerpPositionLifecycle: vi.fn(),
  clearActivePerpPositionLifecycle: vi.fn(),
  listPerpTrades: vi.fn(() => []),
}));

const dbRun = vi.fn(() => ({}));
const dbPrepare = vi.fn((sql: string) => {
  if (sql.includes('COUNT(*)')) return { get: () => ({ c: 0 }) };
  return { run: dbRun, all: () => [], get: () => undefined };
});
vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({ exec: vi.fn(), prepare: dbPrepare }),
}));

vi.mock('../../src/execution/perp-risk.js', () => ({
  checkPerpRiskLimits: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../../src/core/autonomy_policy.js', () => ({
  evaluateGlobalTradeGate: vi.fn(() => ({ allowed: true })),
  classifyMarketRegime: vi.fn(() => 'trending'),
  resolveVolatilityBucket: vi.fn(() => 'medium'),
  resolveLiquidityBucket: vi.fn(() => 'normal'),
}));

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  getPositionExitPolicy: vi.fn(() => null),
  clearPositionExitPolicy: vi.fn(),
  upsertPositionExitPolicy: vi.fn(),
}));

vi.mock('../../src/memory/paper_perps.js', () => ({
  getPaperPerpBookSummary: vi.fn(() => ({ cashBalanceUsdc: 500, positionValue: 0 })),
  listPaperPerpPositions: vi.fn(() => []),
  listPaperPerpPositionsWithMark: vi.fn(() => []),
  listPaperPerpFills: vi.fn(() => []),
  placePaperPerpOrder: vi.fn(() => ({ orderId: 'p1', fillPrice: 69000 })),
}));

vi.mock('../../src/memory/portfolio.js', () => ({
  getCashBalance: vi.fn(() => 10000),
}));

vi.mock('../../src/memory/llm_entry_gate_log.js', () => ({
  recordEntryGateDecision: vi.fn(),
}));

vi.mock('../../src/core/decision_component_scores.js', () => ({
  computeClosedTradeComponentScores: vi.fn(() => null),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx() {
  return {
    config: {
      execution: { mode: 'paper' },
      paper: { initialCashUsdc: 200 },
      autonomy: { enabled: true, tradeContract: { enabled: false } },
      hyperliquid: { maxLeverage: 10 },
    } as any,
    marketClient: {
      getMarket: async () => ({
        symbol: 'BTC',
        markPrice: 69000,
        metadata: { maxLeverage: 10 },
      }),
    } as any,
    executor: {
      execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })),
    } as any,
    limiter: {
      checkAndReserve: vi.fn(async () => ({ allowed: true })),
      getRemainingDaily: vi.fn(() => 1000),
      release: vi.fn(),
      confirm: vi.fn(),
    } as any,
  };
}

// An entry journal record (what the open trade wrote)
function makeEntryJournalRecord(signalClass: string) {
  return {
    kind: 'perp_trade_journal' as const,
    symbol: 'BTC',
    side: 'buy' as const,          // original open was a buy
    reduceOnly: false,
    outcome: 'executed' as const,
    signalClass,
    hypothesisId: null,
    size: 0.01,
    markPrice: 70000,
    expectedEdge: 0.05,
    invalidationPrice: null,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('perp_place_order — close inherits signalClass from entry journal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inherits signalClass from matching open entry on a reduce-only close', async () => {
    listPerpTradeJournalsMock.mockReturnValue([makeEntryJournalRecord('mean_reversion')]);

    const { executeToolCall } = await import('../../src/core/tool-executor.js');

    await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTC',
        side: 'sell',         // closing a long (buy→sell)
        size: 0.01,
        reduce_only: true,
        exit_mode: 'take_profit',
      },
      makeCtx()
    );

    // Find the close journal entry (reduceOnly=true)
    const closeCall = recordPerpTradeJournalMock.mock.calls.find(
      (call) => (call[0] as any)?.reduceOnly === true
    );
    expect(closeCall).toBeDefined();
    expect((closeCall![0] as any).signalClass).toBe('mean_reversion');
  });

  it('leaves signalClass null when no matching entry record exists', async () => {
    listPerpTradeJournalsMock.mockReturnValue([]); // no history

    const { executeToolCall } = await import('../../src/core/tool-executor.js');

    await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTC',
        side: 'sell',
        size: 0.01,
        reduce_only: true,
        exit_mode: 'take_profit',
      },
      makeCtx()
    );

    const closeCall = recordPerpTradeJournalMock.mock.calls.find(
      (call) => (call[0] as any)?.reduceOnly === true
    );
    expect(closeCall).toBeDefined();
    expect((closeCall![0] as any).signalClass).toBeNull();
  });

  it('respects explicitly supplied signal_class over the inferred one', async () => {
    listPerpTradeJournalsMock.mockReturnValue([makeEntryJournalRecord('mean_reversion')]);

    const { executeToolCall } = await import('../../src/core/tool-executor.js');

    await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTC',
        side: 'sell',
        size: 0.01,
        reduce_only: true,
        exit_mode: 'take_profit',
        signal_class: 'momentum_breakout', // explicit override
      },
      makeCtx()
    );

    const closeCall = recordPerpTradeJournalMock.mock.calls.find(
      (call) => (call[0] as any)?.reduceOnly === true
    );
    expect(closeCall).toBeDefined();
    // explicit wins over reference
    expect((closeCall![0] as any).signalClass).toBe('momentum_breakout');
  });
});
