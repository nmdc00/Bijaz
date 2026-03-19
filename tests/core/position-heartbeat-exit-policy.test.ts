/**
 * Tests for per-position exit policy integration with the heartbeat service.
 *
 * Validates:
 * - time_stop (thesis deadline) causes close before generic time_ceiling
 * - invalidation_price causes close when mark crosses it
 * - generic time_ceiling is suppressed when an explicit time stop is set
 * - clearPositionExitPolicy is called after policy-driven close
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '../../src/core/logger.js';
import { PositionHeartbeatService } from '../../src/core/position_heartbeat.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../src/memory/position_heartbeat_journal.js', () => ({
  recordPositionHeartbeatDecision: () => {},
}));

vi.mock('../../src/memory/paper_perps.js', () => ({
  placePaperPerpOrder: vi.fn().mockReturnValue({
    orderId: 'mock-liq',
    filled: true,
    fillPrice: 100,
    markPrice: 100,
    slippageBps: 0,
    realizedPnlUsd: 0,
    feeUsd: 0,
    message: 'ok',
  }),
  listPaperPerpPositions: () => [],
}));

const mockGetPolicy = vi.fn();
const mockClearPolicy = vi.fn();

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  getPositionExitPolicy: (...args: unknown[]) => mockGetPolicy(...args),
  clearPositionExitPolicy: (...args: unknown[]) => mockClearPolicy(...args),
  upsertPositionExitPolicy: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSafeConfig(triggerOverrides: Record<string, unknown> = {}) {
  return {
    execution: { mode: 'live', provider: 'hyperliquid' },
    heartbeat: {
      enabled: true,
      tickIntervalSeconds: 1,
      rollingBufferSize: 10,
      triggers: {
        pnlShiftPct: 99,
        liquidationProximityPct: 0.001, // won't fire for liqDist=50%
        volatilitySpikePct: 99,
        volatilitySpikeWindowTicks: 100,
        timeCeilingMinutes: 9999,       // won't fire
        triggerCooldownSeconds: 0,
        ...triggerOverrides,
      },
    },
  } as any;
}

function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'ETH',
    side: 'long',
    size: 1,
    unrealized_pnl: 10,
    return_on_equity: 5,
    liquidation_price: 50, // liqDist = (100-50)/100 = 50% → no proximity trigger
    ...overrides,
  };
}

function makeService(
  config: any,
  positions: unknown[],
  mid = 100,
  notified: string[] = []
) {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const toolExec = async (toolName: string, toolInput: Record<string, unknown>) => {
    calls.push({ tool: toolName, input: toolInput });
    if (toolName === 'get_positions') {
      return { success: true as const, data: { positions } };
    }
    if (toolName === 'perp_place_order') {
      return { success: true as const, data: { ok: true } };
    }
    return { success: false as const, error: `unexpected: ${toolName}` };
  };
  const client = { getAllMids: async () => ({ ETH: mid }) } as any;
  const service = new PositionHeartbeatService(
    config,
    { config } as any,
    new Logger('error'),
    { client, toolExec: toolExec as any, notify: async (m) => { notified.push(m); } }
  );
  return { service, calls };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('position heartbeat — per-position exit policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes position when timeStopAtMs is in the past', async () => {
    // Policy says close this position 1 second ago
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() - 1000,
      invalidationPrice: null,
      notes: null,
    });

    const config = makeSafeConfig();
    const notified: string[] = [];
    const { service, calls } = makeService(config, [makePosition()], 100, notified);

    service.start();
    await service.tickOnce();
    service.stop();

    const orders = calls.filter((c) => c.tool === 'perp_place_order');
    expect(orders.length).toBe(1);
    expect(orders[0]!.input.reduce_only).toBe(true);
    expect(orders[0]!.input.side).toBe('sell'); // close long → sell
    expect(notified[0]).toContain('ETH');
    expect(notified[0]).toContain('🎯');
    expect(mockClearPolicy).toHaveBeenCalledWith('ETH');
  });

  it('does not close when timeStopAtMs is in the future', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() + 999_999,
      invalidationPrice: null,
      notes: null,
    });

    const config = makeSafeConfig();
    const notified: string[] = [];
    const { service, calls } = makeService(config, [makePosition()], 100, notified);

    service.start();
    await service.tickOnce();
    service.stop();

    expect(calls.some((c) => c.tool === 'perp_place_order')).toBe(false);
    expect(notified.length).toBe(0);
    expect(mockClearPolicy).not.toHaveBeenCalled();
  });

  it('closes long when mark falls to or below invalidationPrice', async () => {
    // Long ETH invalidated if mark drops to 90
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: null,
      invalidationPrice: 90,
      notes: null,
    });

    const config = makeSafeConfig();
    const notified: string[] = [];
    const { service, calls } = makeService(config, [makePosition()], 89, notified); // mid=89 ≤ 90

    service.start();
    await service.tickOnce();
    service.stop();

    const orders = calls.filter((c) => c.tool === 'perp_place_order');
    expect(orders.length).toBe(1);
    expect(orders[0]!.input.reduce_only).toBe(true);
    expect(notified[0]).toContain('🎯');
    expect(mockClearPolicy).toHaveBeenCalledWith('ETH');
  });

  it('does not close long when mark is above invalidationPrice', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: null,
      invalidationPrice: 90,
      notes: null,
    });

    const config = makeSafeConfig();
    const notified: string[] = [];
    const { service, calls } = makeService(config, [makePosition()], 95, notified); // mid=95 > 90

    service.start();
    await service.tickOnce();
    service.stop();

    expect(calls.some((c) => c.tool === 'perp_place_order')).toBe(false);
    expect(notified.length).toBe(0);
  });

  it('closes short when mark rises to or above invalidationPrice', async () => {
    // Short ETH invalidated if mark rises to 110
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'short',
      timeStopAtMs: null,
      invalidationPrice: 110,
      notes: null,
    });

    const config = makeSafeConfig();
    const notified: string[] = [];
    const { service, calls } = makeService(
      config,
      [makePosition({ side: 'short', liquidation_price: 200 })],
      111, // mid=111 ≥ 110
      notified
    );

    service.start();
    await service.tickOnce();
    service.stop();

    const orders = calls.filter((c) => c.tool === 'perp_place_order');
    expect(orders.length).toBe(1);
    expect(orders[0]!.input.side).toBe('buy'); // close short → buy
    expect(notified[0]).toContain('🎯');
    expect(mockClearPolicy).toHaveBeenCalledWith('ETH');
  });

  it('suppresses generic time_ceiling when explicit time stop is set (future)', async () => {
    // time_ceiling would fire at 0.0001 min ≈ 6ms, but policy has a future time stop → suppressed
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() + 999_999, // far future
      invalidationPrice: null,
      notes: null,
    });

    const config = makeSafeConfig({ timeCeilingMinutes: 0.0001, liquidationProximityPct: 0.001 });
    const notified: string[] = [];
    const { service, calls } = makeService(config, [makePosition()], 100, notified);

    service.start();
    await service.tickOnce();
    await new Promise((r) => setTimeout(r, 15)); // wait > 6ms
    await service.tickOnce(); // would normally fire time_ceiling here
    service.stop();

    // Should not have fired since time_ceiling is suppressed
    expect(calls.some((c) => c.tool === 'perp_place_order')).toBe(false);
    expect(notified.length).toBe(0);
  });

  it('no policy → normal trigger behaviour unchanged', async () => {
    // No policy set → falls through to generic time_ceiling
    mockGetPolicy.mockReturnValue(null);

    const config = makeSafeConfig({ timeCeilingMinutes: 0.0001, liquidationProximityPct: 0.001 });
    const notified: string[] = [];
    const { service, calls } = makeService(config, [makePosition()], 100, notified);

    service.start();
    await service.tickOnce();
    await new Promise((r) => setTimeout(r, 15));
    await service.tickOnce();
    service.stop();

    expect(calls.some((c) => c.tool === 'perp_place_order')).toBe(true);
    expect(notified[0]).toContain('time_ceiling');
  });
});
