import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/intel/vectorstore.js', () => ({
  IntelVectorStore: class {
    async query() {
      return [];
    }
  },
}));

vi.mock('../../src/intel/store.js', () => ({
  listRecentIntel: () => [],
  listIntelByIds: () => [],
}));

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({
    prepare: () => ({
      get: () => undefined,
      all: () => [],
      run: () => ({}),
    }),
    exec: () => undefined,
    pragma: () => undefined,
  }),
}));

vi.mock('../../src/memory/user.js', () => ({
  getUserContext: () => ({ preferences: {} }),
  updateUserContext: () => {},
}));

vi.mock('../../src/memory/session_store.js', () => ({
  SessionStore: class {
    getSummary() {
      return '';
    }
    async compactIfNeeded() {
      return;
    }
    buildContextMessages() {
      return [];
    }
    appendEntry() {
      return;
    }
    getSessionId() {
      return 's1';
    }
    clearSession() {
      return;
    }
  },
}));

vi.mock('../../src/memory/chat.js', () => ({
  storeChatMessage: () => 'm1',
  listChatMessagesByIds: () => [],
  clearChatMessages: () => undefined,
}));

vi.mock('../../src/memory/chat_vectorstore.js', () => ({
  ChatVectorStore: class {
    async add() {
      return true;
    }
    async query() {
      return [];
    }
  },
}));

const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
vi.mock('../../src/core/tool-executor.js', () => ({
  executeToolCall: async (name: string, input: Record<string, unknown> = {}) => {
    toolCalls.push({ name, input });
    if (name === 'perp_market_list') {
      return { success: true as const, data: { markets: [] } };
    }
    // Keep other tool calls benign.
    return { success: true as const, data: {} };
  },
}));

describe('ConversationHandler tool-first snapshot', () => {
  it('calls perp_market_list for trade intent even if user does not mention prices', async () => {
    toolCalls.length = 0;
    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = {
      complete: vi.fn(async () => ({ content: 'ok', model: 'test' })),
    };
    const marketClient = { searchMarkets: vi.fn(async () => []) };
    const config = { execution: { mode: 'paper', provider: 'hyperliquid' } } as any;

    const handler = new ConversationHandler(llm as any, marketClient as any, config);
    await handler.chat('user', 'Can you place a perp trade?');

    expect(toolCalls.some((call) => call.name === 'perp_market_list')).toBe(true);
  });

  it('queries explicit commodity tickers and widens market snapshot coverage', async () => {
    toolCalls.length = 0;
    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = {
      complete: vi.fn(async () => ({ content: 'ok', model: 'test' })),
    };
    const marketClient = { searchMarkets: vi.fn(async () => []) };
    const config = { execution: { mode: 'paper', provider: 'hyperliquid' } } as any;

    const handler = new ConversationHandler(llm as any, marketClient as any, config);
    await handler.chat('user', 'Do you see CL/USDC in the commodities tickers on Hyperliquid?');

    expect(toolCalls).toContainEqual({ name: 'perp_market_list', input: { limit: 200 } });
    expect(toolCalls).toContainEqual({ name: 'perp_market_get', input: { symbol: 'CL/USDC' } });
  });
});
