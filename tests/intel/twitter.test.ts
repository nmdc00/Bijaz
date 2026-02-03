import { describe, expect, it, vi } from 'vitest';

import { TwitterFetcher } from '../../src/intel/twitter.js';

const baseConfig = {
  intel: {
    sources: {
      twitter: {
        enabled: true,
        bearerToken: 'test-bearer',
        baseUrl: 'https://twitter.local/2',
        keywords: ['augur'],
      },
    },
  },
};

describe('TwitterFetcher', () => {
  it('returns empty when bearer is missing', async () => {
    const fetcher = new TwitterFetcher({
      intel: { sources: { twitter: { enabled: true } } },
    } as any);
    const items = await fetcher.fetch();
    expect(items).toEqual([]);
  });

  it('fetches and normalizes tweets', async () => {
    const response = {
      data: [
        {
          id: '123',
          text: 'Breaking: test tweet',
          created_at: '2026-01-26T00:00:00Z',
        },
      ],
    };

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => response,
    }));

    vi.stubGlobal('fetch', fetchMock as any);

    const fetcher = new TwitterFetcher(baseConfig as any);
    const items = await fetcher.fetch();

    expect(fetchMock).toHaveBeenCalled();
    expect(items).toEqual([
      {
        title: 'Breaking: test tweet',
        content: 'Breaking: test tweet',
        url: 'https://twitter.com/i/web/status/123',
        publishedAt: '2026-01-26T00:00:00Z',
        source: 'Twitter/X',
      },
    ]);

    vi.unstubAllGlobals();
  });
});
