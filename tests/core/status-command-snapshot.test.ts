import { describe, it, expect, vi } from 'vitest';

import { Logger } from '../../src/core/logger.js';
import { STATUS_SNAPSHOT_MAX_CHARS } from '../../src/core/status_snapshot.js';

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
  it('returns one bounded message with required operator fields', async () => {
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
