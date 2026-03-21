/**
 * Tests for exit policy write/clear in tool-executor.
 *
 * Validates:
 * - Exit policy is written after successful non-reduce-only entry when thesis_expires_at_ms provided
 * - Exit policy is NOT written when thesis_expires_at_ms is absent
 * - Exit policy is cleared when reduce-only fully closes the position
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeToolCall } from '../../src/core/tool-executor.js';
import { PaperExecutor } from '../../src/execution/modes/paper.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const upsertExitPolicy = vi.fn();
const clearExitPolicy = vi.fn();
vi.mock('../../src/memory/position_exit_policy.js', () => ({
  upsertPositionExitPolicy: (...args: unknown[]) => upsertExitPolicy(...args),
  clearPositionExitPolicy: (...args: unknown[]) => clearExitPolicy(...args),
  getPositionExitPolicy: () => null,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

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

const limiter = {
  checkAndReserve: async () => ({ allowed: true }),
  confirm: () => {},
  release: () => {},
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('tool-executor — exit policy write on perp_place_order', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    vi.clearAllMocks();
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-exit-policy-'));
    process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');
  });

  afterEach(() => {
    if (process.env.THUFIR_DB_PATH) {
      rmSync(process.env.THUFIR_DB_PATH, { force: true });
      rmSync(dirname(process.env.THUFIR_DB_PATH), { recursive: true, force: true });
    }
    if (originalDbPath === undefined) delete process.env.THUFIR_DB_PATH;
    else process.env.THUFIR_DB_PATH = originalDbPath;
  });

  it('writes exit policy with thesis_expires_at_ms on successful non-reduce-only entry', async () => {
    const thesisExpiresAtMs = Date.now() + 60 * 60_000; // 1 hour
    const executor = new PaperExecutor({ initialCashUsdc: 200 });

    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTC',
        side: 'buy',
        size: 0.001,
        mode: 'paper',
        thesis_expires_at_ms: thesisExpiresAtMs,
      },
      {
        config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
        marketClient,
        executor,
        limiter,
      }
    );

    expect(res.success).toBe(true);
    expect(upsertExitPolicy).toHaveBeenCalledOnce();
    const [symbol, side, timeStop, invalidation, notes] = upsertExitPolicy.mock.calls[0]!;
    expect(symbol).toBe('BTC');
    expect(side).toBe('long');           // buy → long
    expect(timeStop).toBe(thesisExpiresAtMs);
    expect(invalidation).toBeNull();
    expect(typeof notes).toBe('string');
  });

  it('writes a notes-only exit policy when thesis_expires_at_ms is absent', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });

    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.001, mode: 'paper' },
      {
        config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
        marketClient,
        executor,
        limiter,
      }
    );

    expect(res.success).toBe(true);
    expect(upsertExitPolicy).toHaveBeenCalledOnce();
    const [symbol, side, timeStop, invalidation, notes] = upsertExitPolicy.mock.calls[0]!;
    expect(symbol).toBe('BTC');
    expect(side).toBe('long');
    expect(timeStop).toBeNull();
    expect(invalidation).toBeNull();
    expect(typeof notes).toBe('string');
  });

  it('clears exit policy when reduce-only fully closes a paper position', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });

    // Open a position first
    await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.001, mode: 'paper' },
      {
        config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
        marketClient,
        executor,
        limiter,
      }
    );

    vi.clearAllMocks(); // Reset to isolate the close call

    // Close it fully
    const closeRes = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'sell', size: 0.001, reduce_only: true, mode: 'paper' },
      {
        config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
        marketClient,
        executor,
        limiter,
      }
    );

    expect(closeRes.success).toBe(true);
    // Position fully closed → policy should be cleared
    expect(clearExitPolicy).toHaveBeenCalledWith('BTC');
  });

  it('does NOT clear exit policy when reduce-only only partially closes', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });

    // Open a 0.002 position
    await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.002, mode: 'paper' },
      {
        config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
        marketClient,
        executor,
        limiter,
      }
    );

    vi.clearAllMocks();

    // Partially close (0.001 of 0.002)
    const closeRes = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'sell', size: 0.001, reduce_only: true, mode: 'paper' },
      {
        config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
        marketClient,
        executor,
        limiter,
      }
    );

    expect(closeRes.success).toBe(true);
    // Partial close → position still open → policy NOT cleared
    expect(clearExitPolicy).not.toHaveBeenCalled();
  });

  it('maps sell side correctly: sell → short for exit policy', async () => {
    const thesisExpiresAtMs = Date.now() + 30 * 60_000;
    const executor = new PaperExecutor({ initialCashUsdc: 200 });

    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'ETH',
        side: 'sell',
        size: 0.01,
        mode: 'paper',
        thesis_expires_at_ms: thesisExpiresAtMs,
      },
      {
        config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
        marketClient: {
          ...marketClient,
          getMarket: async (symbol: string) => ({
            id: symbol,
            symbol,
            markPrice: 3000,
            metadata: { maxLeverage: 10 },
          }),
        },
        executor,
        limiter,
      }
    );

    expect(res.success).toBe(true);
    const [symbol, side] = upsertExitPolicy.mock.calls[0]!;
    expect(symbol).toBe('ETH');
    expect(side).toBe('short'); // sell → short
  });

  it('persists explicit exit_contract notes for heartbeat consumption', async () => {
    const thesisExpiresAtMs = Date.now() + 60 * 60_000;
    const executor = new PaperExecutor({ initialCashUsdc: 200 });

    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTC',
        side: 'buy',
        size: 0.001,
        mode: 'paper',
        thesis_expires_at_ms: thesisExpiresAtMs,
        exit_contract: {
          thesis: 'Hold while BTC structure remains intact',
          hardRules: [
            { metric: 'mark_price', op: '<=', value: 49000, action: 'close', reason: 'structure lost' },
          ],
          reviewGuidance: ['If momentum stalls after breakout, reduce risk.'],
        },
      },
      {
        config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
        marketClient,
        executor,
        limiter,
      }
    );

    expect(res.success).toBe(true);
    const [, , , , notes] = upsertExitPolicy.mock.calls[0]!;
    expect(typeof notes).toBe('string');
    expect(String(notes)).toContain('Hold while BTC structure remains intact');
    expect(String(notes)).toContain('structure lost');
  });
});
