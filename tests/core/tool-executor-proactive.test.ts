import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/proactive_search.js', () => ({
  runProactiveSearch: vi.fn(async (_config: unknown, _options: unknown) => ({
    storedCount: 3,
    storedItems: [],
    queries: ['btc funding rates'],
    rounds: 2,
    learnedSeedQueries: ['eth basis'],
  })),
  formatProactiveSummary: vi.fn(() => 'summary text'),
}));

import { executeToolCall } from '../../src/core/tool-executor.js';
import { runProactiveSearch } from '../../src/core/proactive_search.js';

describe('tool-executor proactive search tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs proactive_search_run with mapped options', async () => {
    const res = await executeToolCall(
      'proactive_search_run',
      {
        max_queries: 8,
        iterations: 2,
        extra_queries: ['btc funding rates'],
        include_learned_queries: true,
        web_limit_per_query: 5,
        fetch_per_query: 1,
      },
      { config: {} as any, marketClient: {} as any }
    );

    expect(res.success).toBe(true);
    expect(vi.mocked(runProactiveSearch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runProactiveSearch)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxQueries: 8,
        iterations: 2,
        extraQueries: ['btc funding rates'],
        includeLearnedQueries: true,
        webLimitPerQuery: 5,
        fetchPerQuery: 1,
      })
    );
    if (res.success) {
      const data = res.data as { summary?: string; rounds?: number };
      expect(data.summary).toBe('summary text');
      expect(data.rounds).toBe(2);
    }
  });
});
