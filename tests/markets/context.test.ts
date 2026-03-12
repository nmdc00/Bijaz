import { describe, expect, it, vi } from 'vitest';

import {
  buildMarketContextRequests,
  classifyMarketContextDomain,
  gatherMarketContext,
} from '../../src/markets/context.js';

describe('classifyMarketContextDomain', () => {
  it('routes oil and geopolitics prompts away from crypto', () => {
    expect(classifyMarketContextDomain('Could Iran escalation push oil higher through Hormuz?')).toBe('energy');
  });

  it('keeps crypto prompts on the crypto path', () => {
    expect(classifyMarketContextDomain('What is the BTC perp funding regime today?')).toBe('crypto');
  });
});

describe('buildMarketContextRequests', () => {
  it('preserves crypto parity with perp market and funding tools', () => {
    const requests = buildMarketContextRequests({
      message: 'latest BTC perp funding regime',
    });

    expect(requests.some((request) => request.toolName === 'perp_market_list' && request.required)).toBe(true);
    expect(requests.some((request) => request.toolName === 'signal_hyperliquid_funding_oi_skew')).toBe(true);
  });

  it('uses non-perp primary context for energy domains', () => {
    const requests = buildMarketContextRequests({
      message: 'Iran escalation and Hormuz disruption impact on oil',
    });

    expect(requests.some((request) => request.label === 'web_search:market_context:energy' && request.required)).toBe(true);
    expect(requests.some((request) => request.toolName === 'perp_market_list' && request.required)).toBe(false);
  });
});

describe('gatherMarketContext', () => {
  it('returns a domain-aware snapshot with fallback web market context', async () => {
    const executeTool = vi.fn(async (toolName: string, input: Record<string, unknown>) => {
      if (toolName === 'current_time') return { success: true as const, data: { iso: '2026-03-12T00:00:00Z' } };
      if (toolName === 'intel_search') return { success: true as const, data: [{ title: 'Oil headline' }] };
      if (toolName === 'web_search') return { success: true as const, data: [{ query: input.query }] };
      return { success: false as const, error: 'unexpected tool' };
    });

    const snapshot = await gatherMarketContext(
      { message: 'Could Iran escalation push oil higher through Hormuz?' },
      executeTool
    );

    expect(snapshot.domain).toBe('energy');
    expect(snapshot.primarySource).toBe('web_search:market_context:energy');
    expect(snapshot.sources).toContain('web_search:market_context:energy');
  });
});
