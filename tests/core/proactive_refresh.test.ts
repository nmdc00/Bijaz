import { describe, expect, it, vi } from 'vitest';

import {
  appendProactiveAttribution,
  isTimeSensitivePrompt,
  runProactiveRefresh,
  type ProactiveRefreshSettings,
} from '../../src/core/proactive_refresh.js';

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
      if (toolName === 'web_search') return { success: true, data: [{ title: 'Market update' }] };
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
    expect(outcome.snapshot?.sources).toContain('web_search');
    expect(outcome.contextText).toContain('as_of:');

    const reply = appendProactiveAttribution('Current view: mildly bullish.', outcome.snapshot ?? null);
    expect(reply).toContain('as_of:');
    expect(reply).toContain('sources:');
  });
});
