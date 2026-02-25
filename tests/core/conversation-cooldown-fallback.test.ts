import { describe, expect, it, vi } from 'vitest';

const runOrchestratorMock = vi.fn(async () => ({
  response: '',
  state: {
    plan: null,
    toolExecutions: [],
    criticResult: null,
    mode: 'trade',
  },
  summary: { fragility: null },
}));

vi.mock('../../src/intel/vectorstore.js', () => ({
  IntelVectorStore: class {
    async query() {
      return [];
    }
  },
}));

vi.mock('../../src/intel/store.js', () => ({
  listIntelByIds: () => [],
  listRecentIntel: () => [],
}));

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({
    prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }),
    exec: () => undefined,
    pragma: () => undefined,
  }),
}));

vi.mock('../../src/memory/user.js', () => ({
  getUserContext: () => ({ preferences: { intelAlertsConfigured: true } }),
  updateUserContext: () => undefined,
}));

vi.mock('../../src/memory/session_store.js', () => ({
  SessionStore: class {
    getSummary() {
      return null;
    }
    async compactIfNeeded() {}
    buildContextMessages() {
      return [];
    }
    appendEntry() {}
    getSessionId() {
      return 's1';
    }
    clearSession() {}
    getPlan() {
      return null;
    }
    setPlan() {}
    clearPlan() {}
  },
}));

vi.mock('../../src/memory/chat.js', () => ({
  storeChatMessage: () => 'm1',
  listChatMessagesByIds: () => [],
  clearChatMessages: () => undefined,
  pruneChatMessages: () => 0,
}));

vi.mock('../../src/memory/chat_vectorstore.js', () => ({
  ChatVectorStore: class {
    async add() {}
    async query() {
      return [];
    }
  },
}));

vi.mock('../../src/agent/orchestrator/orchestrator.js', () => ({
  runOrchestrator: runOrchestratorMock,
}));

vi.mock('../../src/core/tool-executor.js', () => ({
  executeToolCall: async (name: string) => {
    if (name === 'get_portfolio') {
      return { success: true, data: { summary: { available_balance: 1.2345 } } };
    }
    if (name === 'get_positions') {
      return { success: true, data: { positions: [{ symbol: 'BTC' }] } };
    }
    if (name === 'get_open_orders') {
      return { success: true, data: { orders: [] } };
    }
    return { success: true, data: {} };
  },
}));

describe('ConversationHandler cooldown fallback', () => {
  it('returns deterministic non-empty response when orchestrator synthesis is empty', async () => {
    runOrchestratorMock.mockClear();
    runOrchestratorMock.mockResolvedValue({
      response: '',
      state: {
        plan: null,
        toolExecutions: [],
        criticResult: null,
        mode: 'trade',
      },
      summary: { fragility: null },
    });
    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = { complete: vi.fn(async () => ({ content: 'ok', model: 'test' })) } as any;
    const marketClient = { searchMarkets: vi.fn(async () => []) } as any;
    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      agent: { useOrchestrator: true },
      autonomy: { fullAuto: true },
    } as any;

    const handler = new ConversationHandler(llm, marketClient, config);
    const reply = await handler.chat('user', 'Can you monitor the position?');

    expect(reply).toContain('Monitoring is still active');
    expect(reply).toContain('perp position');
    expect(reply.trim().length).toBeGreaterThan(0);
  });

  it('uses autonomous execution origin for heartbeat and chat origin for normal messages', async () => {
    runOrchestratorMock.mockClear();
    runOrchestratorMock.mockResolvedValue({
      response: 'ok',
      state: {
        plan: null,
        toolExecutions: [],
        criticResult: null,
        mode: 'trade',
      },
      summary: { fragility: null },
    });

    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = { complete: vi.fn(async () => ({ content: 'ok', model: 'test' })) } as any;
    const marketClient = { searchMarkets: vi.fn(async () => []) } as any;
    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      agent: { useOrchestrator: true },
      autonomy: { fullAuto: true },
    } as any;

    const handler = new ConversationHandler(llm, marketClient, config);
    await handler.chat('__heartbeat__', 'Read heartbeat');
    await handler.chat('user', 'Buy BTC now');

    expect(runOrchestratorMock).toHaveBeenCalledTimes(2);
    expect(runOrchestratorMock.mock.calls[0]?.[2]).toMatchObject({
      executionOrigin: 'autonomous',
      allowTradeMutations: true,
    });
    expect(runOrchestratorMock.mock.calls[1]?.[2]).toMatchObject({
      executionOrigin: 'chat',
      allowTradeMutations: true,
    });
  });

  it('allows autonomous reduce-only trade confirmations when full auto is disabled', async () => {
    runOrchestratorMock.mockClear();
    runOrchestratorMock.mockImplementationOnce(async (_goal: string, ctx: any) => {
      const allowReduceOnly = await ctx.onConfirmation(
        'Execute perp_place_order?',
        'perp_place_order',
        { symbol: 'BTC', side: 'sell', size: 0.1, reduce_only: true }
      );
      const allowIncrease = await ctx.onConfirmation(
        'Execute perp_place_order?',
        'perp_place_order',
        { symbol: 'BTC', side: 'buy', size: 0.1, reduce_only: false }
      );
      return {
        response: JSON.stringify({ allowReduceOnly, allowIncrease }),
        state: {
          plan: null,
          toolExecutions: [],
          criticResult: null,
          mode: 'trade',
        },
        summary: { fragility: null },
      };
    });

    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = { complete: vi.fn(async () => ({ content: 'ok', model: 'test' })) } as any;
    const marketClient = { searchMarkets: vi.fn(async () => []) } as any;
    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      agent: { useOrchestrator: true },
      autonomy: { fullAuto: false },
    } as any;

    const handler = new ConversationHandler(llm, marketClient, config);
    const reply = await handler.chat('__heartbeat__', 'Manage position risk.');
    const parsed = JSON.parse(reply) as { allowReduceOnly: boolean; allowIncrease: boolean };
    expect(parsed.allowReduceOnly).toBe(true);
    expect(parsed.allowIncrease).toBe(false);
  });

  it('suppresses repeated planning progress updates while preserving stage transitions', async () => {
    runOrchestratorMock.mockClear();
    runOrchestratorMock.mockImplementationOnce(async (_goal: string, ctx: any) => {
      const update = ctx?.onUpdate as ((state: any) => void) | undefined;
      update?.({ plan: null, toolExecutions: [] });
      update?.({ plan: null, toolExecutions: [] });
      update?.({ plan: { complete: false }, toolExecutions: [] });
      update?.({ plan: { complete: false }, toolExecutions: [] });
      update?.({
        plan: { complete: false },
        toolExecutions: [{ toolName: 'perp_market_get' }],
      });
      update?.({
        plan: { complete: true },
        toolExecutions: [{ toolName: 'perp_market_get' }],
      });
      return {
        response: 'ok',
        state: {
          plan: { complete: true },
          toolExecutions: [{ toolName: 'perp_market_get' }],
          criticResult: null,
          mode: 'trade',
        },
        summary: { fragility: null },
      };
    });

    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = { complete: vi.fn(async () => ({ content: 'ok', model: 'test' })) } as any;
    const marketClient = { searchMarkets: vi.fn(async () => []) } as any;
    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      agent: { useOrchestrator: true },
      autonomy: { fullAuto: true },
    } as any;
    const onProgress = vi.fn(async () => undefined);

    const handler = new ConversationHandler(llm, marketClient, config);
    await handler.chat('user', 'Run a quick check', onProgress);

    const progressMessages = onProgress.mock.calls.map((call) => String(call[0]));
    expect(progressMessages.filter((m) => m.includes('analyzing request')).length).toBe(1);
    expect(progressMessages.filter((m) => m.includes('building execution plan')).length).toBe(1);
    expect(progressMessages.some((m) => m.includes('running perp_market_get'))).toBe(true);
    expect(progressMessages.filter((m) => m.includes('finalizing response')).length).toBe(1);
  });
});
