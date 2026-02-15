import { describe, it, expect, vi } from 'vitest';

import { Logger } from '../../src/core/logger.js';

vi.mock('../../src/core/llm.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/core/llm.js'
  );
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

describe('access status routing', () => {
  it('does not return access status for natural-language tool-access questions', async () => {
    const { ThufirAgent } = await import('../../src/core/agent.js');
    const agent = new ThufirAgent({
      execution: { mode: 'live', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: false },
      agent: { model: 'test', provider: 'local' },
    } as any, new Logger('error'));

    const res = await agent.handleMessage('u', 'How is the tool access?');
    expect(res).not.toMatch(/Access status/i);
  });

  it('returns access status only for explicit /access_status command', async () => {
    const { ThufirAgent } = await import('../../src/core/agent.js');
    const agent = new ThufirAgent({
      execution: { mode: 'live', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: false },
      agent: { model: 'test', provider: 'local' },
    } as any, new Logger('error'));

    const res = await agent.handleMessage('u', '/access_status');
    expect(res).toMatch(/Access status/i);
  });
});
