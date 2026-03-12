import { describe, expect, it, vi } from 'vitest';

import { cached, clearDashboardCache } from '../../src/gateway/dashboard_cache.js';

describe('dashboard cache', () => {
  it('returns cached value within ttl', () => {
    clearDashboardCache();
    const fn = vi.fn(() => ({ ok: true }));
    const first = cached('a', 10_000, fn);
    const second = cached('a', 10_000, fn);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('expires entries after ttl', async () => {
    clearDashboardCache();
    const fn = vi.fn(() => Math.random());
    const first = cached('b', 1, fn);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = cached('b', 1, fn);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it('keeps keys independent', () => {
    clearDashboardCache();
    const fnA = vi.fn(() => 'a');
    const fnB = vi.fn(() => 'b');
    expect(cached('key-a', 10_000, fnA)).toBe('a');
    expect(cached('key-b', 10_000, fnB)).toBe('b');
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });
});
