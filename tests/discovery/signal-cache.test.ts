import { describe, it, expect, beforeEach } from 'vitest';
import { TTLCache } from '../../src/discovery/signal_cache.js';

describe('TTLCache', () => {
  let cache: TTLCache<string>;

  beforeEach(() => {
    cache = new TTLCache<string>(1000); // 1 second TTL
  });

  it('stores and retrieves values', () => {
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  it('returns undefined for missing keys', () => {
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('returns undefined for expired entries', async () => {
    const shortCache = new TTLCache<string>(50); // 50ms TTL
    shortCache.set('key1', 'value1');
    expect(shortCache.get('key1')).toBe('value1');

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(shortCache.get('key1')).toBeUndefined();
  });

  it('respects custom per-entry TTL', async () => {
    cache.set('short', 'value', 50);
    cache.set('long', 'value', 5000);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBe('value');
  });

  it('has() checks existence and expiry', async () => {
    const shortCache = new TTLCache<string>(50);
    shortCache.set('key1', 'value1');
    expect(shortCache.has('key1')).toBe(true);
    expect(shortCache.has('missing')).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(shortCache.has('key1')).toBe(false);
  });

  it('clear() removes all entries', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('size prunes expired entries', async () => {
    const shortCache = new TTLCache<string>(50);
    shortCache.set('a', '1');
    shortCache.set('b', '2');
    expect(shortCache.size).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(shortCache.size).toBe(0);
  });

  it('isolates keys correctly', () => {
    cache.set('price_vol:BTC', 'btc_result');
    cache.set('price_vol:ETH', 'eth_result');
    expect(cache.get('price_vol:BTC')).toBe('btc_result');
    expect(cache.get('price_vol:ETH')).toBe('eth_result');
    expect(cache.get('price_vol:SOL')).toBeUndefined();
  });

  it('overwrites existing entries', () => {
    cache.set('key1', 'old');
    cache.set('key1', 'new');
    expect(cache.get('key1')).toBe('new');
  });

  it('can cache null values (for null signal results)', () => {
    const nullCache = new TTLCache<string | null>(1000);
    nullCache.set('key1', null);
    expect(nullCache.get('key1')).toBeNull();
    expect(nullCache.has('key1')).toBe(true);
  });
});
