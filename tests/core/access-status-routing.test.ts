import { describe, it, expect, vi } from 'vitest';

import { Logger } from '../../src/core/logger.js';

const conversationChatMock = vi.hoisted(() => vi.fn(async () => 'ok'));

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
    async chat(sender: string, message: string) {
      return conversationChatMock(sender, message);
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

  it('does not apply natural-language trade shortcut to heartbeat prompts in paper mode', async () => {
    conversationChatMock.mockReset();
    conversationChatMock.mockResolvedValue('ok');

    const { ThufirAgent } = await import('../../src/core/agent.js');
    const agent = new ThufirAgent({
      execution: { mode: 'paper', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: true, fullAuto: false },
      agent: { model: 'test', provider: 'local' },
    } as any, new Logger('error'));

    const prompt = 'If you execute any action, monitor open position risk.';
    const res = await agent.handleMessage('__heartbeat__', prompt);

    expect(res).toBe('ok');
    expect(conversationChatMock).toHaveBeenCalledWith('__heartbeat__', prompt);
  });
});
