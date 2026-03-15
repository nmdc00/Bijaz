import { describe, expect, it, vi } from 'vitest';

// Capture the args passed to evaluateGlobalTradeGate so we can assert on signalClass.
const capturedGateInputs: Array<unknown> = [];

vi.mock('../../src/core/autonomy_policy.js', () => ({
  evaluateGlobalTradeGate: (_config: unknown, input: unknown) => {
    capturedGateInputs.push(input);
    return {
      allowed: false,
      reason: 'test-blocked',
      policyState: {
        minEdgeOverride: null,
        maxTradesPerScanOverride: null,
        leverageCapOverride: null,
        observationOnlyUntilMs: null,
        reason: null,
        updatedAt: new Date().toISOString(),
      },
    };
  },
}));

describe('tool-executor signal_class validation', () => {
  const marketClient = {
    getMarket: async (symbol: string) => ({
      id: symbol,
      question: `Perp: ${symbol}`,
      outcomes: ['LONG', 'SHORT'],
      prices: {},
      platform: 'hyperliquid',
      kind: 'perp',
      symbol,
      markPrice: 88,
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

  it('non-canonical signal_class falls through to null when no hypothesis_id is provided', async () => {
    capturedGateInputs.length = 0;
    const { executeToolCall } = await import('../../src/core/tool-executor.js');

    await executeToolCall(
      'perp_place_order',
      { symbol: 'SOL', side: 'buy', size: 1, signal_class: 'scan_trend_follow', trade_archetype: 'swing' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );

    expect(capturedGateInputs.length).toBeGreaterThan(0);
    const gateInput = capturedGateInputs[0] as Record<string, unknown>;
    // Non-canonical label must NOT pass through; no hypothesis to fall back on → null
    expect(gateInput.signalClass).toBeNull();
  });

  it('non-canonical signal_class falls back to hypothesis ID inference', async () => {
    capturedGateInputs.length = 0;
    const { executeToolCall } = await import('../../src/core/tool-executor.js');

    await executeToolCall(
      'perp_place_order',
      {
        symbol: 'SOL',
        side: 'buy',
        size: 1,
        signal_class: 'scan_trend_follow',
        hypothesis_id: 'hyp_sol_trend_01',
        trade_archetype: 'swing',
      },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );

    expect(capturedGateInputs.length).toBeGreaterThan(0);
    const gateInput = capturedGateInputs[0] as Record<string, unknown>;
    // _trend in hypothesis_id → momentum_breakout
    expect(gateInput.signalClass).toBe('momentum_breakout');
  });

  it('canonical signal_class passes through unchanged', async () => {
    capturedGateInputs.length = 0;
    const { executeToolCall } = await import('../../src/core/tool-executor.js');

    await executeToolCall(
      'perp_place_order',
      { symbol: 'SOL', side: 'buy', size: 1, signal_class: 'mean_reversion', trade_archetype: 'intraday' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );

    expect(capturedGateInputs.length).toBeGreaterThan(0);
    const gateInput = capturedGateInputs[0] as Record<string, unknown>;
    expect(gateInput.signalClass).toBe('mean_reversion');
  });
});
