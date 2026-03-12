import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/memory/watchlist.js', () => ({
  listWatchlist: vi.fn(),
}));

vi.mock('../../src/intel/store.js', () => ({
  listRecentIntel: vi.fn(() => []),
  storeIntel: vi.fn((item: unknown) => item),
}));

vi.mock('../../src/execution/market-client.js', () => ({
  createMarketClient: vi.fn(() => ({ isAvailable: () => false })),
}));

vi.mock('../../src/core/tool-executor.js', () => ({
  executeToolCall: vi.fn(),
}));

vi.mock('../../src/core/llm.js', () => ({
  createLlmClient: vi.fn(() => ({ chat: vi.fn(async () => ({ content: '' })) })),
  createTrivialTaskClient: vi.fn(() => ({ chat: vi.fn(async () => ({ content: '' })) })),
}));

vi.mock('../../src/core/llm_infra.js', () => ({
  withExecutionContextIfMissing: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../src/intel/sources_registry.js', () => ({
  listQueryCapableRoamingSources: vi.fn(() => []),
}));

vi.mock('../../src/memory/proactive_queries.js', () => ({
  listLearnedProactiveQueries: vi.fn(() => []),
  recordProactiveQueryOutcome: vi.fn(),
}));

vi.mock('../../src/intel/pipeline.js', () => ({
  runIntelPipelineDetailedWithOverrides: vi.fn(async () => ({
    storedCount: 0,
    storedItems: [],
    queries: [],
    rounds: 0,
    learnedSeedQueries: [],
  })),
}));

import { listWatchlist } from '../../src/memory/watchlist.js';
import { storeIntel } from '../../src/intel/store.js';
import { executeToolCall } from '../../src/core/tool-executor.js';
import { runProactiveSearch } from '../../src/core/proactive_search.js';

const mockConfig = {} as any;

describe('proactive search — Hyperliquid watchlist data collection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches funding/OI skew and orderflow imbalance for each watchlist symbol', async () => {
    vi.mocked(listWatchlist).mockReturnValue([
      { marketId: 'BTC-PERP', label: 'Bitcoin', addedAt: '' },
      { marketId: 'ETH-PERP', label: 'Ethereum', addedAt: '' },
    ] as any);

    vi.mocked(executeToolCall).mockImplementation(async (toolName, args) => {
      if (toolName === 'signal_hyperliquid_funding_oi_skew') {
        return { success: true, data: { fundingRate: 0.0001, oiSkew: 1.2, symbol: (args as any).symbol } };
      }
      if (toolName === 'signal_hyperliquid_orderflow_imbalance') {
        return { success: true, data: { imbalance: 0.3, symbol: (args as any).symbol } };
      }
      return { success: false, error: 'unexpected tool' };
    });

    const result = await runProactiveSearch(mockConfig, {
      maxQueries: 0,
      watchlistLimit: 5,
      useLlm: false,
      recentIntelLimit: 0,
      includeLearnedQueries: false,
    });

    // 2 symbols × 2 tools = 4 storeIntel calls for HL data
    const hlCalls = vi.mocked(storeIntel).mock.calls.filter(([item]: any[]) =>
      (item.source as string)?.startsWith('hyperliquid:')
    );
    expect(hlCalls.length).toBe(4);

    const btcFunding = hlCalls.find(([item]: any[]) => item.title === 'BTC funding/OI skew');
    expect(btcFunding).toBeDefined();
    const ethOrderflow = hlCalls.find(([item]: any[]) => item.title === 'ETH orderflow imbalance');
    expect(ethOrderflow).toBeDefined();

    // HL items should be included in storedItems
    expect(result.storedCount).toBeGreaterThanOrEqual(4);
    expect(result.storedItems.some((i) => i.source === 'hyperliquid:signal_hyperliquid_funding_oi_skew')).toBe(true);
  });

  it('skips symbol when executeToolCall returns no data', async () => {
    vi.mocked(listWatchlist).mockReturnValue([
      { marketId: 'SOL-PERP', label: 'Solana', addedAt: '' },
    ] as any);

    vi.mocked(executeToolCall).mockResolvedValue({ success: false, error: 'unavailable' });

    const result = await runProactiveSearch(mockConfig, {
      maxQueries: 0,
      watchlistLimit: 5,
      useLlm: false,
      recentIntelLimit: 0,
      includeLearnedQueries: false,
    });

    const hlCalls = vi.mocked(storeIntel).mock.calls.filter(([item]: any[]) =>
      (item.source as string)?.startsWith('hyperliquid:')
    );
    expect(hlCalls.length).toBe(0);
    expect(result.storedCount).toBe(0);
  });

  it('does nothing when watchlist is empty', async () => {
    vi.mocked(listWatchlist).mockReturnValue([]);

    await runProactiveSearch(mockConfig, {
      maxQueries: 0,
      watchlistLimit: 5,
      useLlm: false,
      recentIntelLimit: 0,
      includeLearnedQueries: false,
    });

    expect(vi.mocked(executeToolCall)).not.toHaveBeenCalledWith(
      expect.stringContaining('signal_hyperliquid'),
      expect.anything(),
      expect.anything()
    );
  });

  it('strips symbol suffix from marketId (BTC-PERP → BTC)', async () => {
    vi.mocked(listWatchlist).mockReturnValue([
      { marketId: 'BTC-PERP', label: 'Bitcoin', addedAt: '' },
    ] as any);

    vi.mocked(executeToolCall).mockResolvedValue({ success: true, data: { fundingRate: 0.0002 } });

    await runProactiveSearch(mockConfig, {
      maxQueries: 0,
      watchlistLimit: 5,
      useLlm: false,
      recentIntelLimit: 0,
      includeLearnedQueries: false,
    });

    const calls = vi.mocked(executeToolCall).mock.calls;
    const fundingCall = calls.find(([name]) => name === 'signal_hyperliquid_funding_oi_skew');
    expect(fundingCall?.[1]).toEqual({ symbol: 'BTC' });
  });
});
