/**
 * executor-toolsubset-wiring.test.ts
 *
 * Verifies that ConversationHandler passes toolSubset='execution' to
 * createAgenticExecutorClient when the executor model path is active.
 *
 * This guards against regressions where someone drops the 4th argument from
 * the createAgenticExecutorClient() call in conversation.ts, which would
 * silently revert to the full (50-tool) schema for every agentic execution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Spy on createAgenticExecutorClient before anything imports conversation.ts
// ---------------------------------------------------------------------------

const { createExecutorSpy } = vi.hoisted(() => ({
  createExecutorSpy: vi.fn(() => ({
    complete: async () => ({ content: '', model: 'gpt-test' }),
    meta: { provider: 'openai' as const, model: 'gpt-test', kind: 'executor' as const },
  })),
}));

vi.mock('../../src/core/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/llm.js')>();
  return {
    ...actual,
    createAgenticExecutorClient: createExecutorSpy,
  };
});

// ---------------------------------------------------------------------------
// Database / filesystem stubs (same pattern as conversation.test.ts)
// ---------------------------------------------------------------------------

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({
    prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }),
    exec: () => undefined,
    pragma: () => undefined,
  }),
}));

vi.mock('../../src/memory/session_store.js', () => ({
  SessionStore: class {
    getSummary() { return ''; }
    async compactIfNeeded() { return; }
    buildContextMessages() { return []; }
    appendEntry() { return; }
    getSessionId() { return 's1'; }
    clearSession() { return; }
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
    async add() { return true; }
    async query() { return []; }
  },
}));

vi.mock('../../src/memory/user.js', () => ({
  getUserContext: () => ({ preferences: {} }),
  updateUserContext: () => {},
}));

vi.mock('../../src/intel/vectorstore.js', () => ({
  IntelVectorStore: class {
    async query() { return []; }
  },
}));

vi.mock('../../src/intel/store.js', () => ({
  listRecentIntel: () => [],
  listIntelByIds: () => [],
}));

// ---------------------------------------------------------------------------
// Module-level import — vi.mock is hoisted so mocks are active before this
// ---------------------------------------------------------------------------

import { ConversationHandler } from '../../src/core/conversation.js';

const llm = { complete: vi.fn(async () => ({ content: '', model: 'test' })) };
const marketClient = { searchMarkets: vi.fn(async () => []) };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executor toolSubset wiring', () => {
  beforeEach(() => createExecutorSpy.mockClear());

  it('ConversationHandler creates executor client with "chat" toolSubset', () => {
    // Config that activates the executor model path:
    // provider=anthropic, executorProvider=openai → different, so shouldUseExecutorModel=true
    const config = {
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        executorModel: 'gpt-5.2',
        executorProvider: 'openai',
        useExecutorModel: true,
        workspace: '/tmp/nonexistent-wiring-test',
      },
    } as any;

    // Constructing ConversationHandler triggers the executor wiring in the constructor
    new ConversationHandler(llm as any, marketClient as any, config);

    expect(createExecutorSpy).toHaveBeenCalled();
    const [, , modelOverride, toolSubset] = createExecutorSpy.mock.calls[0]!;
    expect(modelOverride).toBeUndefined();
    expect(toolSubset).toBe('chat');
  });

  it('ConversationHandler does NOT call createAgenticExecutorClient when useExecutorModel is false', () => {
    const config = {
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        useExecutorModel: false,
        workspace: '/tmp/nonexistent-wiring-test',
      },
    } as any;

    new ConversationHandler(llm as any, marketClient as any, config);

    expect(createExecutorSpy).not.toHaveBeenCalled();
  });
});
