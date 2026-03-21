import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resilientWebSearch,
  resetWebSearchResilienceStateForTests,
} from '../../src/intel/web_search_resilience.js';

describe('web search provider resilience', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  const baseConfig = {
    intel: {
      webSearch: {
        enabled: true,
        providers: {
          order: ['brave', 'serpapi', 'duckduckgo'],
          brave: { enabled: true },
          serpapi: { enabled: true },
          duckduckgo: { enabled: true },
        },
        cache: { enabled: false, ttlSeconds: 60, maxEntries: 100 },
        budgets: { maxQueriesPerDay: 500, perProviderDailyCaps: {} },
        circuitBreaker: { failureThreshold: 2, openSeconds: 300 },
      },
    },
  } as const;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetWebSearchResilienceStateForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    resetWebSearchResilienceStateForTests();
  });

  it('falls back to next provider after quota failure', async () => {
    process.env.BRAVE_API_KEY = 'brave-key';
    process.env.SERPAPI_KEY = 'serp-key';
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('api.search.brave.com')) {
        return Promise.resolve({ ok: false, status: 429 });
      }
      if (url.includes('serpapi.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            organic_results: [{ title: 'serp', link: 'https://serp.example', snippet: 'ok' }],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });
    // @ts-expect-error test mock
    globalThis.fetch = fetchMock;

    const result = await resilientWebSearch('btc news', 3, baseConfig as any);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.provider).toBe('serpapi');
    expect(result.data.attempts).toHaveLength(2);
    expect(result.data.attempts[0]?.provider).toBe('brave');
    expect(result.data.attempts[0]?.status).toBe('failed');
    expect(result.data.attempts[0]?.error_class).toBe('rate_limited');
    expect(result.data.attempts[1]?.provider).toBe('serpapi');
    expect(result.data.attempts[1]?.status).toBe('ok');
    expect(result.data.results[0]?.url).toBe('https://serp.example');
  });

  it('uses cache on repeat query and avoids provider calls', async () => {
    process.env.BRAVE_API_KEY = 'brave-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [{ title: 'brave', url: 'https://brave.example', description: 'ok' }],
        },
      }),
    });
    // @ts-expect-error test mock
    globalThis.fetch = fetchMock;

    const cfg = {
      ...baseConfig,
      intel: {
        ...baseConfig.intel,
        webSearch: {
          ...baseConfig.intel.webSearch,
          cache: { enabled: true, ttlSeconds: 300, maxEntries: 100 },
        },
      },
    };

    const first = await resilientWebSearch('eth setup', 2, cfg as any);
    const second = await resilientWebSearch('eth setup', 2, cfg as any);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (!second.success) return;
    expect(second.data.cache.hit).toBe(true);
    expect(second.data.attempts).toEqual([]);
  });

  it('enforces global daily query budget', async () => {
    process.env.BRAVE_API_KEY = 'brave-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [{ title: 'brave', url: 'https://brave.example', description: 'ok' }],
        },
      }),
    });
    // @ts-expect-error test mock
    globalThis.fetch = fetchMock;

    const cfg = {
      ...baseConfig,
      intel: {
        ...baseConfig.intel,
        webSearch: {
          ...baseConfig.intel.webSearch,
          budgets: { maxQueriesPerDay: 1, perProviderDailyCaps: {} },
        },
      },
    };

    const first = await resilientWebSearch('first', 1, cfg as any);
    const second = await resilientWebSearch('second', 1, cfg as any);
    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error).toContain('daily budget exhausted');
  });

  it('skips provider when per-provider cap is reached', async () => {
    process.env.BRAVE_API_KEY = 'brave-key';
    process.env.SERPAPI_KEY = 'serp-key';
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('serpapi.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            organic_results: [{ title: 'serp', link: 'https://serp.example', snippet: 'ok' }],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });
    // @ts-expect-error test mock
    globalThis.fetch = fetchMock;

    const cfg = {
      ...baseConfig,
      intel: {
        ...baseConfig.intel,
        webSearch: {
          ...baseConfig.intel.webSearch,
          budgets: {
            maxQueriesPerDay: 10,
            perProviderDailyCaps: { brave: 0 },
          },
        },
      },
    };

    const result = await resilientWebSearch('capped provider', 1, cfg as any);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.provider).toBe('serpapi');
    expect(result.data.attempts[0]?.provider).toBe('brave');
    expect(result.data.attempts[0]?.status).toBe('skipped');
    expect(result.data.attempts[0]?.error_class).toBe('quota_exhausted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens circuit breaker and skips failing provider on subsequent call', async () => {
    process.env.BRAVE_API_KEY = 'brave-key';
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('api.search.brave.com')) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      if (url.includes('api.duckduckgo.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            RelatedTopics: [{ Text: 'Duck Topic - summary', FirstURL: 'https://duck.example/topic' }],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });
    // @ts-expect-error test mock
    globalThis.fetch = fetchMock;

    const cfg = {
      ...baseConfig,
      intel: {
        ...baseConfig.intel,
        webSearch: {
          ...baseConfig.intel.webSearch,
          providers: { ...baseConfig.intel.webSearch.providers, order: ['brave', 'duckduckgo'] },
          circuitBreaker: { failureThreshold: 1, openSeconds: 300 },
        },
      },
    };

    const first = await resilientWebSearch('query one', 1, cfg as any);
    const second = await resilientWebSearch('query two', 1, cfg as any);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.attempts[0]?.provider).toBe('brave');
    expect(second.data.attempts[0]?.status).toBe('skipped');
    expect(second.data.attempts[0]?.error).toContain('circuit open');
    expect(second.data.provider).toBe('duckduckgo');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('tavily succeeds with valid API key and returns results', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'BTC News', url: 'https://example.com/btc', content: 'Bitcoin update', published_date: '2024-01-01' },
          { title: 'ETH Analysis', url: 'https://example.com/eth', content: 'Ethereum analysis', published_date: null },
        ],
      }),
    });
    // @ts-expect-error test mock
    globalThis.fetch = fetchMock;

    const cfg = {
      ...baseConfig,
      intel: {
        ...baseConfig.intel,
        webSearch: {
          ...baseConfig.intel.webSearch,
          providers: { order: ['tavily'], tavily: { enabled: true } },
        },
      },
    };

    const result = await resilientWebSearch('btc news', 3, cfg as any);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.provider).toBe('tavily');
    expect(result.data.results[0]?.title).toBe('BTC News');
    expect(result.data.results[0]?.url).toBe('https://example.com/btc');
    expect(result.data.results[0]?.snippet).toBe('Bitcoin update');
    expect(result.data.results[0]?.date).toBe('2024-01-01');
    // Tavily uses POST
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tvly-test-key');
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe('btc news');
    expect(body.api_key).toBeUndefined();
  });

  it('tavily is skipped when API key is missing and falls back to next provider', async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.BRAVE_API_KEY = 'brave-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: { results: [{ title: 'Brave Result', url: 'https://brave.example', description: 'ok' }] },
      }),
    });
    // @ts-expect-error test mock
    globalThis.fetch = fetchMock;

    const cfg = {
      ...baseConfig,
      intel: {
        ...baseConfig.intel,
        webSearch: {
          ...baseConfig.intel.webSearch,
          providers: { order: ['tavily', 'brave'], tavily: { enabled: true }, brave: { enabled: true } },
        },
      },
    };

    const result = await resilientWebSearch('eth news', 3, cfg as any);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.provider).toBe('brave');
    // Tavily was skipped (misconfigured), brave was tried
    const tavilyAttempt = result.data.attempts.find((a) => a.provider === 'tavily');
    expect(tavilyAttempt?.status).toBe('failed');
    expect(tavilyAttempt?.error_class).toBe('provider_misconfigured');
    // fetch only called once (for brave, not for tavily since key absent)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tavily handles non-ok HTTP response and falls back', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    process.env.SERPAPI_KEY = 'serp-key';
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('tavily.com')) {
        return Promise.resolve({ ok: false, status: 401 });
      }
      if (url.includes('serpapi.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            organic_results: [{ title: 'serp', link: 'https://serp.example', snippet: 'ok' }],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });
    // @ts-expect-error test mock
    globalThis.fetch = fetchMock;

    const cfg = {
      ...baseConfig,
      intel: {
        ...baseConfig.intel,
        webSearch: {
          ...baseConfig.intel.webSearch,
          providers: {
            order: ['tavily', 'serpapi'],
            tavily: { enabled: true },
            serpapi: { enabled: true },
          },
        },
      },
    };

    const result = await resilientWebSearch('sol setup', 3, cfg as any);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.provider).toBe('serpapi');
    const tavilyAttempt = result.data.attempts.find((a) => a.provider === 'tavily');
    expect(tavilyAttempt?.status).toBe('failed');
  });
});
