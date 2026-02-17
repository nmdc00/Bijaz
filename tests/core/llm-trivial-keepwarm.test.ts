import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn(async () => ({ ok: true }));

vi.mock('node-fetch', () => ({
  default: fetchMock,
}));

function buildConfig(
  overrides?: Partial<{
    keepWarmEnabled: boolean;
    keepWarmIntervalSeconds: number;
    keepAlive: string;
    localSoftTimeoutMs: number;
    timeoutMs: number;
    fallbackTimeoutMs: number;
  }>
): any {
  return {
    agent: {
      model: 'gpt-5.2',
      provider: 'anthropic',
      fallbackModel: 'claude-3-5-haiku-20241022',
      localBaseUrl: 'http://localhost:11434',
      trivialTaskProvider: 'local',
      trivialTaskModel: 'qwen2.5:1.5b-instruct',
      useProxy: false,
      llmBudget: { enabled: false },
      identityPromptMode: 'minimal',
      internalPromptMode: 'minimal',
      trivial: {
        enabled: true,
        maxTokens: 128,
        temperature: 0.2,
        timeoutMs: overrides?.timeoutMs ?? 12000,
        localSoftTimeoutMs: overrides?.localSoftTimeoutMs ?? 6000,
        fallbackTimeoutMs: overrides?.fallbackTimeoutMs ?? 12000,
        keepWarmEnabled: overrides?.keepWarmEnabled ?? true,
        keepWarmIntervalSeconds: overrides?.keepWarmIntervalSeconds ?? 180,
        keepAlive: overrides?.keepAlive ?? '30m',
      },
    },
  };
}

describe('createTrivialTaskClient keep-warm controls', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends keep-warm ping with configured keep_alive and interval', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { createTrivialTaskClient } = await import('../../src/core/llm.js');

    const client = createTrivialTaskClient(
      buildConfig({
        keepWarmEnabled: true,
        keepWarmIntervalSeconds: 240,
        keepAlive: '45m',
      })
    );

    expect(client).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const payload = JSON.parse(requestInit?.body ?? '{}') as Record<string, unknown>;
    expect(payload.keep_alive).toBe('45m');
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 240_000);
  });

  it('does not run keep-warm when disabled', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { createTrivialTaskClient } = await import('../../src/core/llm.js');

    const client = createTrivialTaskClient(
      buildConfig({
        keepWarmEnabled: false,
      })
    );

    expect(client).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();
  });
});
