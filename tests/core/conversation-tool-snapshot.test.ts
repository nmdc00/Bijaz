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

const toolCalls: string[] = [];
vi.mock('../../src/core/tool-executor.js', () => ({
  executeToolCall: async (name: string) => {
    toolCalls.push(name);
    if (name === 'perp_market_list') {
      return { success: true as const, data: { markets: [] } };
    }
    // Keep other tool calls benign.
    return { success: true as const, data: {} };
  },
}));

describe('ConversationHandler tool-first snapshot', () => {
  it('calls perp_market_list for trade intent even if user does not mention prices', async () => {
    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = {
      complete: vi.fn(async () => ({ content: 'ok', model: 'test' })),
    };
    const marketClient = { searchMarkets: vi.fn(async () => []) };
    const config = { execution: { mode: 'paper', provider: 'hyperliquid' } } as any;

    const handler = new ConversationHandler(llm as any, marketClient as any, config);
    await handler.chat('user', 'Can you place a perp trade?');

    expect(toolCalls).toContain('perp_market_list');
  });
});

