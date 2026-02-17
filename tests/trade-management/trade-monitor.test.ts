import { describe, it, expect, vi } from 'vitest';

import { Logger } from '../../src/core/logger.js';
import { TradeMonitor } from '../../src/trade-management/monitor.js';

vi.mock('../../src/memory/trade_management_state.js', () => {
  let state: any = null;
  return {
    getTradeManagementState: () => state,
    upsertTradeManagementState: (s: any) => {
      state = s;
    },
    deleteTradeManagementState: () => {
      state = null;
    },
  };
});

describe('trade monitor', () => {
  it('places bracket when state exists but orders are missing', async () => {
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
                entry_price: 100,
                liquidation_price: 99,
              },
            ],
          },
        };
      }
      if (toolName === 'perp_place_order') {
        return { success: true as const, data: { ok: true } };
      }
      return { success: false as const, error: `unexpected tool: ${toolName}` };
    };

    const orderCalls: any[] = [];
    const exchange = {
      order: async (payload: any) => {
        orderCalls.push(payload);
        return { status: 'ok' };
      },
    };

    const client = {
      getAllMids: async () => ({ BTC: 100 }),
      getOpenOrders: async () => [],
      listPerpMarkets: async () => [{ symbol: 'BTC', assetId: 1, szDecimals: 2 }],
      getExchangeClient: () => exchange,
    } as any;

    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      tradeManagement: {
        enabled: true,
        defaults: { stopLossPct: 3, takeProfitPct: 5, maxHoldHours: 72 },
        bounds: {
          stopLossPct: { min: 1, max: 8 },
          takeProfitPct: { min: 2, max: 15 },
          maxHoldHours: { min: 1, max: 168 },
        },
        useExchangeStops: true,
        liquidationGuardDistanceBps: 800,
        monitorIntervalSeconds: 900,
        activeMonitorIntervalSeconds: 60,
      },
    } as any;

    const monitor = new TradeMonitor(config, { config } as any, new Logger('error'), {
      client,
      toolExec: toolExec as any,
    });

    monitor.start();
    await monitor.tickOnce();
    monitor.stop();

    expect(orderCalls.length).toBe(1);
    expect(orderCalls[0]!.grouping).toBe('positionTpsl');
  });
});

