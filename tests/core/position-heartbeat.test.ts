import { describe, it, expect, vi } from 'vitest';

import { Logger } from '../../src/core/logger.js';
import { PositionHeartbeatService } from '../../src/core/position_heartbeat.js';

vi.mock('../../src/memory/position_heartbeat_journal.js', () => ({
  recordPositionHeartbeatDecision: () => {},
}));

// Shared helpers
function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    execution: { mode: 'live', provider: 'hyperliquid' },
    heartbeat: {
      enabled: true,
      tickIntervalSeconds: 1,
      rollingBufferSize: 10,
      triggers: {
        pnlShiftPct: 99,
        // safe position has liqDist=50% (mid=100, liq=50); 50 <= 60 fires on tick 1
        liquidationProximityPct: 60,
        volatilitySpikePct: 99,
        volatilitySpikeWindowTicks: 100,
        timeCeilingMinutes: 9999,
        triggerCooldownSeconds: 0,
      },
      ...overrides,
    },
  } as any;
}

function makeSafePosition(symbol = 'ETH') {
  return {
    symbol,
    side: 'long',
    size: 1,
    unrealized_pnl: 10,
    return_on_equity: 1,
    liquidation_price: 50, // mid=100, liqDist=50% — safe
  };
}

describe('position heartbeat', () => {
  it('runs in paper mode and can still execute emergency reduce-only close', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const toolExec = async (toolName: string, toolInput: Record<string, unknown>) => {
      calls.push({ tool: toolName, input: toolInput });
      if (toolName === 'get_positions') {
        return {
          success: true as const,
          data: {
            positions: [
              {
                symbol: 'BTC',
                side: 'long',
                size: 1,
                unrealized_pnl: -5,
                return_on_equity: -0.5,
                liquidation_price: 99,
              },
            ],
            summary: { account_value: 200 },
          },
        };
      }
      if (toolName === 'perp_place_order') {
        return { success: true as const, data: { ok: true } };
      }
      return { success: false as const, error: `unexpected tool: ${toolName}` };
    };

    const config = {
      execution: { mode: 'paper', provider: 'hyperliquid' },
      heartbeat: {
        enabled: true,
        tickIntervalSeconds: 1,
        rollingBufferSize: 10,
        triggers: {
          pnlShiftPct: 1.5,
          liquidationProximityPct: 5,
          volatilitySpikePct: 2,
          volatilitySpikeWindowTicks: 3,
          timeCeilingMinutes: 15,
          triggerCooldownSeconds: 180,
        },
      },
    } as any;

    const client = {
      getAllMids: async () => ({ BTC: 100 }),
    } as any;

    const service = new PositionHeartbeatService(
      config,
      { config } as any,
      new Logger('error'),
      { client, toolExec: toolExec as any }
    );

    service.start();
    await service.tickOnce();
    service.stop();

    const closeCalls = calls.filter((c) => c.tool === 'perp_place_order');
    expect(closeCalls.length).toBe(1);
    expect(closeCalls[0]!.input.symbol).toBe('BTC');
    expect(closeCalls[0]!.input.side).toBe('sell');
    expect(closeCalls[0]!.input.reduce_only).toBe(true);
    expect(closeCalls[0]!.input.order_type).toBe('market');
  });

  it('emergency closes when liquidation distance < 2%', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const toolExec = async (toolName: string, toolInput: Record<string, unknown>) => {
      calls.push({ tool: toolName, input: toolInput });
      if (toolName === 'get_positions') {
        return {
          success: true as const,
          data: {
            positions: [
              {
                symbol: 'BTC',
                side: 'long',
                size: 1,
                unrealized_pnl: -10,
                return_on_equity: -1,
                liquidation_price: 99,
              },
            ],
            summary: { account_value: 1000 },
          },
        };
      }
      if (toolName === 'perp_place_order') {
        return { success: true as const, data: { ok: true } };
      }
      return { success: false as const, error: `unexpected tool: ${toolName}` };
    };

    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      heartbeat: {
        enabled: true,
        tickIntervalSeconds: 1,
        rollingBufferSize: 10,
        triggers: {
          pnlShiftPct: 1.5,
          liquidationProximityPct: 5,
          volatilitySpikePct: 2,
          volatilitySpikeWindowTicks: 3,
          timeCeilingMinutes: 15,
          triggerCooldownSeconds: 180,
        },
      },
    } as any;

    const client = {
      getAllMids: async () => ({ BTC: 100 }),
    } as any;

    const service = new PositionHeartbeatService(
      config,
      { config } as any,
      new Logger('error'),
      { client, toolExec: toolExec as any }
    );

    service.start();
    await service.tickOnce();
    service.stop();

    const closeCalls = calls.filter((c) => c.tool === 'perp_place_order');
    expect(closeCalls.length).toBe(1);
    expect(closeCalls[0]!.input.symbol).toBe('BTC');
    expect(closeCalls[0]!.input.side).toBe('sell');
    expect(closeCalls[0]!.input.reduce_only).toBe(true);
    expect(closeCalls[0]!.input.order_type).toBe('market');
  });

  it('does nothing when liquidation distance is safe', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const toolExec = async (toolName: string, toolInput: Record<string, unknown>) => {
      calls.push({ tool: toolName, input: toolInput });
      if (toolName === 'get_positions') {
        return {
          success: true as const,
          data: {
            positions: [
              {
                symbol: 'BTC',
                side: 'long',
                size: 1,
                unrealized_pnl: 10,
                return_on_equity: 1,
                liquidation_price: 50,
              },
            ],
            summary: { account_value: 1000 },
          },
        };
      }
      return { success: false as const, error: `unexpected tool: ${toolName}` };
    };

    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      heartbeat: {
        enabled: true,
        tickIntervalSeconds: 1,
        rollingBufferSize: 10,
        triggers: {
          pnlShiftPct: 1.5,
          liquidationProximityPct: 5,
          volatilitySpikePct: 2,
          volatilitySpikeWindowTicks: 3,
          timeCeilingMinutes: 15,
          triggerCooldownSeconds: 180,
        },
      },
    } as any;

    const client = {
      getAllMids: async () => ({ BTC: 100 }),
    } as any;

    const service = new PositionHeartbeatService(
      config,
      { config } as any,
      new Logger('error'),
      { client, toolExec: toolExec as any }
    );

    service.start();
    await service.tickOnce();
    service.stop();

    expect(calls.some((c) => c.tool === 'perp_place_order')).toBe(false);
  });

  it('calls infoLlm and notify when triggers fire (non-emergency)', async () => {
    const config = makeConfig();
    const toolExec = async (toolName: string) => {
      if (toolName === 'get_positions') {
        return {
          success: true as const,
          data: { positions: [makeSafePosition('ETH')] },
        };
      }
      return { success: false as const, error: `unexpected: ${toolName}` };
    };
    const client = { getAllMids: async () => ({ ETH: 100 }) } as any;

    const llmResponse = 'ETH long: time-ceiling trigger fired, ROE 1%, liq distance 50% — holding.';
    const llmCalls: string[] = [];
    const infoLlm = {
      complete: async (messages: Array<{ role: string; content: string }>) => {
        llmCalls.push(messages[0]!.content);
        return { content: llmResponse, model: 'local' };
      },
    } as any;

    const notified: string[] = [];
    const notify = async (msg: string) => { notified.push(msg); };

    const service = new PositionHeartbeatService(config, { config } as any, new Logger('error'), {
      client,
      toolExec: toolExec as any,
      infoLlm,
      notify,
    });

    service.start();
    await service.tickOnce();
    service.stop();

    expect(llmCalls.length).toBe(1);
    expect(llmCalls[0]).toContain('ETH');
    expect(notified.length).toBe(1);
    expect(notified[0]).toContain(llmResponse);
  });

  it('falls back to static alert when infoLlm throws', async () => {
    const config = makeConfig();
    const toolExec = async (toolName: string) => {
      if (toolName === 'get_positions') {
        return {
          success: true as const,
          data: { positions: [makeSafePosition('SOL')] },
        };
      }
      return { success: false as const, error: `unexpected: ${toolName}` };
    };
    const client = { getAllMids: async () => ({ SOL: 100 }) } as any;

    const infoLlm = {
      complete: async () => { throw new Error('model unavailable'); },
    } as any;

    const notified: string[] = [];
    const notify = async (msg: string) => { notified.push(msg); };

    const service = new PositionHeartbeatService(config, { config } as any, new Logger('error'), {
      client,
      toolExec: toolExec as any,
      infoLlm,
      notify,
    });

    service.start();
    await service.tickOnce();
    service.stop();

    // notify must still fire even when the LLM fails
    expect(notified.length).toBe(1);
    expect(notified[0]).toContain('SOL');
  });

  it('does not call notify when no triggers fire', async () => {
    // All thresholds set so nothing fires: liqProximity=0.001% (safe pos has 50%), others unreachable
    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      heartbeat: {
        enabled: true,
        tickIntervalSeconds: 1,
        rollingBufferSize: 10,
        triggers: {
          pnlShiftPct: 99,
          liquidationProximityPct: 0.001, // safe pos liqDist=50% > 0.001 → no trigger
          volatilitySpikePct: 99,
          volatilitySpikeWindowTicks: 100,
          timeCeilingMinutes: 9999,
          triggerCooldownSeconds: 9999,
        },
      },
    } as any;

    const toolExec = async (toolName: string) => {
      if (toolName === 'get_positions') {
        return {
          success: true as const,
          data: { positions: [makeSafePosition('BTC')] },
        };
      }
      return { success: false as const, error: `unexpected: ${toolName}` };
    };
    const client = { getAllMids: async () => ({ BTC: 100 }) } as any;

    const notified: string[] = [];
    const infoLlm = {
      complete: async () => ({ content: 'irrelevant', model: 'local' }),
    } as any;

    const service = new PositionHeartbeatService(config, { config } as any, new Logger('error'), {
      client,
      toolExec: toolExec as any,
      infoLlm,
      notify: async (msg) => { notified.push(msg); },
    });

    service.start();
    await service.tickOnce();
    service.stop();

    expect(notified.length).toBe(0);
  });

  it('emergency close does not call infoLlm — fires immediately', async () => {
    const toolCalls: string[] = [];
    const toolExec = async (toolName: string) => {
      toolCalls.push(toolName);
      if (toolName === 'get_positions') {
        return {
          success: true as const,
          data: {
            positions: [{
              symbol: 'BTC', side: 'long', size: 1,
              unrealized_pnl: -10, return_on_equity: -1,
              liquidation_price: 99, // liqDist=(100-99)/100=1% → emergency
            }],
          },
        };
      }
      if (toolName === 'perp_place_order') {
        return { success: true as const, data: { ok: true } };
      }
      return { success: false as const, error: `unexpected: ${toolName}` };
    };
    const client = { getAllMids: async () => ({ BTC: 100 }) } as any;

    const llmCalls: number[] = [];
    const infoLlm = {
      complete: async () => { llmCalls.push(1); return { content: 'x', model: 'local' }; },
    } as any;
    const notified: string[] = [];

    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      heartbeat: {
        enabled: true, tickIntervalSeconds: 1, rollingBufferSize: 10,
        triggers: {
          pnlShiftPct: 1.5, liquidationProximityPct: 5,
          volatilitySpikePct: 2, volatilitySpikeWindowTicks: 3,
          timeCeilingMinutes: 15, triggerCooldownSeconds: 180,
        },
      },
    } as any;

    const service = new PositionHeartbeatService(config, { config } as any, new Logger('error'), {
      client,
      toolExec: toolExec as any,
      infoLlm,
      notify: async (msg) => { notified.push(msg); },
    });

    service.start();
    await service.tickOnce();
    service.stop();

    expect(toolCalls).toContain('perp_place_order');
    expect(llmCalls.length).toBe(0);
    expect(notified.length).toBe(0);
  });

  it('skips notify gracefully when infoLlm is not provided', async () => {
    const config = makeConfig();
    const toolExec = async (toolName: string) => {
      if (toolName === 'get_positions') {
        return {
          success: true as const,
          data: { positions: [makeSafePosition('AVAX')] },
        };
      }
      return { success: false as const, error: `unexpected: ${toolName}` };
    };
    const client = { getAllMids: async () => ({ AVAX: 100 }) } as any;

    // No infoLlm, no notify — should not throw
    const service = new PositionHeartbeatService(config, { config } as any, new Logger('error'), {
      client,
      toolExec: toolExec as any,
    });

    await expect(service.tickOnce()).resolves.toBeUndefined();
  });
});
