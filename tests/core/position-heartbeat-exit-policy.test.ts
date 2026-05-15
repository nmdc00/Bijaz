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
const mockUpsertPolicy = vi.fn();

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  getPositionExitPolicy: (...args: unknown[]) => mockGetPolicy(...args),
  clearPositionExitPolicy: (...args: unknown[]) => mockClearPolicy(...args),
  upsertPositionExitPolicy: (...args: unknown[]) => mockUpsertPolicy(...args),
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
  notified: string[] = [],
  exitConsultant?: any,
  getBookEntry?: (sym: string) => any,
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
    { client, toolExec: toolExec as any, notify: async (m) => { notified.push(m); }, exitConsultant, getBookEntry }
  );
  return { service, calls };
}

const STUB_BOOK_ENTRY = {
  symbol: 'ETH', side: 'long', size: 1, entryPrice: 100,
  thesisExpiresAtMs: Date.now() + 3_600_000,
  entryReasoningText: 'test thesis',
  exitContract: { thesis: 'test thesis', tradeType: 'tactical', hardRules: [], reviewGuidance: [] },
  lastConsultAtMs: 0, lastConsultDecision: null,
  entryAtMs: Date.now() - 30 * 60 * 1000,
} as any;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('position heartbeat — per-position exit policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extends TTL and does NOT close when timeStopAtMs is in the past and no exit consultant', async () => {
    // TTL is a review prompt, not a thesis invalidation. Without an exit consultant,
    // the position should extend its TTL by 4 h and hold.
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

    expect(calls.some((c) => c.tool === 'perp_place_order')).toBe(false);
    expect(mockUpsertPolicy).toHaveBeenCalledOnce();
    const [sym, side, newTtl] = mockUpsertPolicy.mock.calls[0];
    expect(sym).toBe('ETH');
    expect(side).toBe('long');
    expect(newTtl).toBeGreaterThan(Date.now()); // extended into the future
    expect(mockClearPolicy).not.toHaveBeenCalled();
  });

  it('closes when TTL fires and exit consultant says close', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() - 1000,
      invalidationPrice: null,
      notes: null,
    });

    const exitConsultant = {
      shouldConsult: vi.fn().mockReturnValue(false),
      consult: vi.fn().mockResolvedValue({ action: 'close' }),
    };

    const config = makeSafeConfig();
    const notified: string[] = [];
    const { service, calls } = makeService(config, [makePosition()], 100, notified, exitConsultant, () => STUB_BOOK_ENTRY);

    service.start();
    await service.tickOnce();
    service.stop();

    const orders = calls.filter((c) => c.tool === 'perp_place_order');
    expect(orders.length).toBe(1);
    expect(orders[0]!.input.side).toBe('sell');
    expect(orders[0]!.input.reduce_only).toBe(true);
    expect(notified[0]).toContain('🎯');
    expect(mockClearPolicy).toHaveBeenCalledWith('ETH');
  });

  it('extends TTL when TTL fires and exit consultant says hold', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() - 1000,
      invalidationPrice: null,
      notes: null,
    });

    const exitConsultant = {
      shouldConsult: vi.fn().mockReturnValue(false),
      consult: vi.fn().mockResolvedValue({ action: 'hold' }),
    };

    const config = makeSafeConfig();
    const { service, calls } = makeService(config, [makePosition()], 100, [], exitConsultant, () => STUB_BOOK_ENTRY);

    service.start();
    await service.tickOnce();
    service.stop();

    expect(calls.some((c) => c.tool === 'perp_place_order')).toBe(false);
    expect(mockUpsertPolicy).toHaveBeenCalledOnce();
    expect(mockClearPolicy).not.toHaveBeenCalled();
  });

  it('closes instead of extending when tactical TTL cap is already exhausted', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() - 1000,
      invalidationPrice: null,
      notes: null,
      entryAtMs: Date.now() - 7 * 60 * 60 * 1000,
    });

    const exitConsultant = {
      shouldConsult: vi.fn().mockReturnValue(false),
      consult: vi.fn().mockResolvedValue({ action: 'hold' }),
    };

    const exhaustedBookEntry = {
      ...STUB_BOOK_ENTRY,
      thesisExpiresAtMs: Date.now() - 1000,
      entryAtMs: Date.now() - 7 * 60 * 60 * 1000,
    };

    const { service, calls } = makeService(
      makeSafeConfig(),
      [makePosition()],
      100,
      [],
      exitConsultant,
      () => exhaustedBookEntry
    );

    service.start();
    await service.tickOnce();
    service.stop();

    const orders = calls.filter((c) => c.tool === 'perp_place_order');
    expect(orders.length).toBe(1);
    expect(mockUpsertPolicy).not.toHaveBeenCalled();
    expect(mockClearPolicy).toHaveBeenCalledWith('ETH');
  });

  it('extends TTL when TTL fires and exit consultant LLM is unavailable', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() - 1000,
      invalidationPrice: null,
      notes: null,
    });

    const exitConsultant = {
      shouldConsult: vi.fn().mockReturnValue(false),
      consult: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    };

    const config = makeSafeConfig();
    const { service, calls } = makeService(config, [makePosition()], 100, [], exitConsultant, () => STUB_BOOK_ENTRY);

    service.start();
    await service.tickOnce();
    service.stop();

    expect(calls.some((c) => c.tool === 'perp_place_order')).toBe(false);
    expect(mockUpsertPolicy).toHaveBeenCalledOnce();
    expect(mockClearPolicy).not.toHaveBeenCalled();
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

  it('executes deterministic exit_contract hard-rule close', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: null,
      invalidationPrice: null,
      notes: JSON.stringify({
        thesis: 'Hold while ETH stays above support',
        hardRules: [
          { metric: 'mark_price', op: '<=', value: 95, action: 'close', reason: 'support lost' },
        ],
        reviewGuidance: ['If momentum stalls, ask Thufir whether to keep holding.'],
      }),
    });

    const config = makeSafeConfig();
    const notified: string[] = [];
    const { service, calls } = makeService(config, [makePosition()], 94, notified);

    service.start();
    await service.tickOnce();
    service.stop();

    const orders = calls.filter((c) => c.tool === 'perp_place_order');
    expect(orders.length).toBe(1);
    expect(notified[0]).toContain('exit_contract');
    expect(notified[0]).toContain('support lost');
    expect(mockClearPolicy).toHaveBeenCalledWith('ETH');
  });

  it('executes deterministic exit_contract hard-rule reduce without clearing policy', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: null,
      invalidationPrice: null,
      notes: JSON.stringify({
        thesis: 'Hold while ETH trend stays healthy',
        hardRules: [
          { metric: 'roe_pct', op: '>=', value: 4, action: 'reduce', reason: 'de-risk into strength', reduceToFraction: 0.4 },
        ],
        reviewGuidance: [],
      }),
    });

    const config = makeSafeConfig();
    const notified: string[] = [];
    const { service, calls } = makeService(config, [makePosition({ size: 2, return_on_equity: 5 })], 100, notified);

    service.start();
    await service.tickOnce();
    service.stop();

    const orders = calls.filter((c) => c.tool === 'perp_place_order');
    expect(orders.length).toBe(1);
    expect(orders[0]!.input.side).toBe('sell');
    expect(orders[0]!.input.size).toBeCloseTo(1.2);
    expect(notified[0]).toContain('exit_contract');
    expect(notified[0]).toContain('de-risk into strength');
    expect(mockClearPolicy).not.toHaveBeenCalled();
  });

  it('ignores malformed exit_contract notes and does not close', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: null,
      invalidationPrice: null,
      notes: '{bad-json',
    });

    const config = makeSafeConfig();
    const notified: string[] = [];
    const { service, calls } = makeService(config, [makePosition()], 100, notified);

    service.start();
    await service.tickOnce();
    service.stop();

    expect(calls.some((c) => c.tool === 'perp_place_order')).toBe(false);
    expect(notified).toHaveLength(0);
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
