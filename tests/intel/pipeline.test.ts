import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('runIntelPipelineDetailed', () => {
  it('returns stored items when sources produce data', async () => {
    vi.doMock('../../src/intel/rss.js', () => ({
      RssFetcher: class {
        async fetch() {
          return [
            {
              title: 'RSS item',
              content: 'Content',
              url: 'https://example.com/rss',
              publishedAt: '2026-01-26T00:00:00Z',
              source: 'RSS',
              category: 'news',
            },
          ];
        }
      },
    }));
    vi.doMock('../../src/intel/newsapi.js', () => ({
      NewsApiFetcher: class {
        async fetch() {
          return [];
        }
      },
    }));
    vi.doMock('../../src/intel/googlenews.js', () => ({
      GoogleNewsFetcher: class {
        async fetch() {
          return [];
        }
      },
    }));
    vi.doMock('../../src/intel/twitter.js', () => ({
      TwitterFetcher: class {
        async fetch() {
          return [];
        }
      },
    }));
    vi.doMock('../../src/intel/vectorstore.js', () => ({
      IntelVectorStore: class {
        async add() {
          return true;
        }
      },
    }));
    vi.doMock('../../src/intel/store.js', () => ({
      storeIntel: () => true,
    }));

    const { runIntelPipelineDetailed } = await import('../../src/intel/pipeline.js');
    const result = await runIntelPipelineDetailed({
      intel: { sources: { rss: { enabled: true, feeds: [] } } },
    } as any);

    expect(result.storedCount).toBe(1);
    expect(result.storedItems).toHaveLength(1);
    expect(result.storedItems[0]?.title).toBe('RSS item');
  });
});
