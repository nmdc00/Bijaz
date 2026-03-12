import { describe, expect, it, vi } from 'vitest';

import {
  appendProactiveAttribution,
  isTimeSensitivePrompt,
  runProactiveRefresh,
  type ProactiveRefreshSettings,
} from '../../src/core/proactive_refresh.js';

vi.mock('../../src/intel/store.js', () => ({
  listIntelByIds: (ids: string[]) =>
    ids.map((id) => ({
      id,
      title: `Intel ${id}`,
      content: 'Iran threatens to disrupt shipping through Hormuz and tighten crude supply.',
      source: 'intel',
      sourceType: 'news',
      timestamp: '2026-03-12T00:00:00Z',
    })),
}));

vi.mock('../../src/events/extract.js', () => ({
  extractEventsFromIntel: vi.fn(() => ({ events: [], gaps: [] })),
}));

vi.mock('../../src/events/thoughts.js', () => ({
  ensureThoughtForEvent: vi.fn(),
  ensureForecastsForThought: vi.fn(() => []),
}));

vi.mock('../../src/events/outcomes.js', () => ({
  collectForecastMarketSnapshot: vi.fn(async () => []),
  sweepExpiredForecasts: vi.fn(() => ({ expired: [], unresolved: [] })),
}));

const baseSettings: ProactiveRefreshSettings = {
  enabled: true,
  intentMode: 'time_sensitive',
  ttlSeconds: 900,
  maxLatencyMs: 1000,
  marketLimit: 20,
  intelLimit: 5,
  webLimit: 5,
  strictFailClosed: true,
  fundingSymbols: ['BTC', 'ETH'],
};

describe('proactive refresh', () => {
  it('detects time-sensitive prompts', () => {
    expect(isTimeSensitivePrompt('Are we in a bull or bear market today?')).toBe(true);
    expect(isTimeSensitivePrompt('Hello there')).toBe(false);
  });

  it('returns cached snapshot when TTL is fresh', async () => {
    const executeTool = vi.fn(async () => ({ success: true, data: { ok: true } }));
    const cached = {
      ts: Date.now(),
      snapshot: {
        asOf: new Date().toISOString(),
        query: 'cached',
        sources: ['perp_market_list'],
        data: { markets: [{ symbol: 'BTC' }] },
      },
    };

    const outcome = await runProactiveRefresh({
      message: 'latest regime?',
      settings: baseSettings,
      cached,
      executeTool,
    });

    expect(outcome.triggered).toBe(true);
    expect(outcome.fromCache).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
    expect(outcome.contextText).toContain('Proactive Fresh Snapshot');
  });

  it('fails closed when fresh evidence cannot be fetched', async () => {
    const executeTool = vi.fn(async () => ({ success: false, error: 'unavailable' }));
    const outcome = await runProactiveRefresh({
      message: 'bull or bear this week?',
      settings: baseSettings,
      executeTool,
    });

    expect(outcome.triggered).toBe(true);
    expect(outcome.failClosed).toBe(true);
    expect(outcome.snapshot).toBeUndefined();
  });

  it('builds snapshot and attribution when refresh succeeds', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'perp_market_list') return { success: true, data: [{ symbol: 'BTC' }] };
      if (toolName === 'web_search') return { success: true, data: { results: [{ title: 'Market update' }] } };
      if (toolName === 'current_time') return { success: true, data: { iso: '2026-01-01T00:00:00Z' } };
      return { success: false, error: 'not configured' };
    });

    const outcome = await runProactiveRefresh({
      message: 'latest macro regime update',
      settings: baseSettings,
      executeTool,
    });

    expect(outcome.failClosed).toBe(false);
    expect(outcome.snapshot?.sources).toContain('perp_market_list');
    expect(outcome.snapshot?.sources.some((source) => source.startsWith('web_search:'))).toBe(true);
    expect(outcome.contextText).toContain('as_of:');

    const reply = appendProactiveAttribution('Current view: mildly bullish.', outcome.snapshot ?? null);
    expect(reply).toContain('as_of:');
    expect(reply).toContain('sources:');
  });

  it('routes oil prompts through domain-specific retrieval instead of funding signals', async () => {
    const executeTool = vi.fn(async (toolName: string, input: Record<string, unknown>) => {
      if (toolName === 'perp_market_list') return { success: true, data: [{ symbol: 'xyz:CL' }] };
      if (toolName === 'current_time') return { success: true, data: { iso: '2026-03-12T00:00:00Z' } };
      if (toolName === 'intel_search') {
        return {
          success: true,
          data: [{ id: `intel-${String(input.query)}`, title: 'Hormuz disruption risk', summary: 'Oil supply risk rises.' }],
        };
      }
      if (toolName === 'web_search') {
        return {
          success: true,
          data: { results: [{ title: 'Hormuz disruption risk', snippet: 'Oil supply risk rises.' }] },
        };
      }
      return { success: false, error: 'unexpected tool' };
    });

    const outcome = await runProactiveRefresh({
      message: 'Could war with Iran push oil higher from here?',
      settings: baseSettings,
      executeTool,
    });

    expect(outcome.failClosed).toBe(false);
    expect(outcome.snapshot?.domain).toBe('energy');
    expect(executeTool).not.toHaveBeenCalledWith(
      'signal_hyperliquid_funding_oi_skew',
      expect.anything()
    );
    expect(outcome.snapshot?.sources.some((source) => source.includes('Iran'))).toBe(true);
  });
});
