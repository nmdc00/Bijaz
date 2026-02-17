import { describe, expect, it, vi } from 'vitest';

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
  runOrchestrator: async () => ({
    response: '',
    state: {
      plan: null,
      toolExecutions: [],
      criticResult: null,
      mode: 'trade',
    },
    summary: { fragility: null },
  }),
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
});
