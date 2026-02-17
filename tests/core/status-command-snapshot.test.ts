import { describe, it, expect, vi } from 'vitest';

import { Logger } from '../../src/core/logger.js';
import { STATUS_SNAPSHOT_MAX_CHARS } from '../../src/core/status_snapshot.js';

const executeToolCallMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/llm.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/core/llm.js');
  const stubClient = {
    complete: async () => ({ content: 'ok', model: 'test' }),
  };
  return {
    ...actual,
    createLlmClient: () => stubClient,
    createExecutorClient: () => stubClient,
    createTrivialTaskClient: () => null,
    createAgenticExecutorClient: () => stubClient,
    clearIdentityCache: () => {},
  };
});

vi.mock('../../src/core/autonomous.js', () => ({
  AutonomousManager: class {
    on() {
      return this;
    }
    start() {}
    stop() {}
    getOperatorSnapshot() {
      return {
        asOf: '2026-02-17T10:00:00.000Z',
        equityUsd: null,
        openPositions: [{ marketId: 'BTC', outcome: 'YES', exposureUsd: 25, unrealizedPnlUsd: 1.5 }],
        policyState: {
          observationOnly: false,
          reason: null,
          minEdgeOverride: null,
          maxTradesPerScanOverride: null,
          leverageCapOverride: null,
          tradeContractEnforced: false,
          decisionQualityGateEnabled: false,
        },
        lastTrade: {
          marketId: 'ETH',
          outcome: 'loss',
          pnlUsd: -2.1,
          timestamp: '2026-02-17T09:55:00.000Z',
        },
        nextScanAt: '2026-02-17T10:15:00.000Z',
        uptimeMs: 123_000,
        runtime: {
          enabled: true,
          fullAuto: true,
          isPaused: false,
          pauseReason: '',
          consecutiveLosses: 1,
          remainingDaily: 75,
        },
        dailyPnl: {
          date: '2026-02-17',
          tradesExecuted: 3,
          wins: 1,
          losses: 1,
          pending: 1,
          realizedPnl: -2.1,
          unrealizedPnl: 1.5,
          totalPnl: -0.6,
        },
      };
    }
  },
}));

vi.mock('../../src/core/tool-executor.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/core/tool-executor.js'
  );
  return {
    ...actual,
    executeToolCall: executeToolCallMock,
  };
});

vi.mock('../../src/core/conversation.js', () => ({
  ConversationHandler: class {
    constructor() {}
    async chat() {
      return 'ok';
    }
  },
}));

vi.mock('../../src/execution/wallet/limits_db.js', () => ({
  DbSpendingLimitEnforcer: class {},
}));

describe('/status command snapshot', () => {
  it('prefers live portfolio/positions data when available', async () => {
    executeToolCallMock.mockReset();
    executeToolCallMock.mockImplementation(async (toolName: string) => {
      if (toolName === 'get_portfolio') {
        return {
          success: true,
          data: {
            summary: { remaining_daily_limit: 42.5 },
            perp_summary: { cross_account_value: 14.79 },
            perp_positions: [
              {
                symbol: 'BTC',
                side: 'long',
                position_value: 44.05,
                unrealized_pnl: 0.13,
              },
            ],
          },
        };
      }
      if (toolName === 'get_positions') {
        return { success: true, data: { positions: [] } };
      }
      return { success: false, error: 'unexpected tool' };
    });

    const { ThufirAgent } = await import('../../src/core/agent.js');
    const agent = new ThufirAgent({
      execution: { mode: 'live', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: true },
      agent: { model: 'test', provider: 'local' },
    } as any, new Logger('error'));

    const res = await agent.handleMessage('u', '/status');
    expect(res).toContain('Equity: $14.79');
    expect(res).toContain('Open positions: BTC YES exp=$44.05 uPnL=+$0.13');
    expect(res).toContain('Remaining daily budget: $42.50');
  });

  it('returns one bounded message with required operator fields', async () => {
    executeToolCallMock.mockReset();
    executeToolCallMock.mockResolvedValue({ success: false, error: 'unavailable' });

    const { ThufirAgent } = await import('../../src/core/agent.js');
    const agent = new ThufirAgent({
      execution: { mode: 'live', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: true },
      agent: { model: 'test', provider: 'local' },
    } as any, new Logger('error'));

    const res = await agent.handleMessage('u', '/status');

    expect(typeof res).toBe('string');
    expect(res.length).toBeLessThanOrEqual(STATUS_SNAPSHOT_MAX_CHARS);
    expect(res).toContain('Equity:');
    expect(res).toContain('Open positions:');
    expect(res).toContain('Policy state:');
    expect(res).toContain('Last trade outcome:');
    expect(res).toContain('Next scan time:');
    expect(res).toContain('Uptime:');
    expect(res).toContain('Daily P&L:');
    expect(res).not.toContain('\n\n\n');
  });
});
