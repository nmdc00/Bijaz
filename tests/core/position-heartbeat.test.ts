import { describe, it, expect, vi } from 'vitest';

import { Logger } from '../../src/core/logger.js';
import { PositionHeartbeatService } from '../../src/core/position_heartbeat.js';

vi.mock('../../src/memory/position_heartbeat_journal.js', () => ({
  recordPositionHeartbeatDecision: () => {},
}));

describe('position heartbeat', () => {
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
});

