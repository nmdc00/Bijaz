import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockPerpDexs,
  mockMetaAndAssetCtxs,
  mockInfoClientCtor,
  mockTransportCtor,
  mockExchangeCtor,
} = vi.hoisted(() => ({
  mockPerpDexs: vi.fn(async () => [{ name: 'dexA' }]),
  mockMetaAndAssetCtxs: vi.fn(async ({ dex }: { dex?: string } = {}) =>
    dex
      ? [{ universe: [{ name: `${dex}:ALT` }] }, [{ markPx: '2', openInterest: '20' }]]
      : [{ universe: [{ name: 'BTC' }] }, [{ markPx: '1', openInterest: '10' }]]
  ),
  mockInfoClientCtor: vi.fn(),
  mockTransportCtor: vi.fn(),
  mockExchangeCtor: vi.fn(),
}));

vi.mock('@nktkas/hyperliquid', () => ({
  HttpTransport: class {
    constructor(args: unknown) {
      mockTransportCtor(args);
    }
  },
  InfoClient: class {
    perpDexs = mockPerpDexs;
    metaAndAssetCtxs = mockMetaAndAssetCtxs;

    constructor(args: unknown) {
      mockInfoClientCtor(args);
    }
  },
  ExchangeClient: class {
    constructor(args: unknown) {
      mockExchangeCtor(args);
    }
  },
}));

describe('HyperliquidClient shared request cache', () => {
  beforeEach(() => {
    vi.resetModules();
    mockPerpDexs.mockClear();
    mockMetaAndAssetCtxs.mockClear();
    mockInfoClientCtor.mockClear();
    mockTransportCtor.mockClear();
    mockExchangeCtor.mockClear();
  });

  it('coalesces merged meta requests across separate client instances', async () => {
    const { HyperliquidClient } = await import('../../src/execution/hyperliquid/client.js');
    const config = { hyperliquid: { enabled: true } } as any;

    const clientA = new HyperliquidClient(config);
    const clientB = new HyperliquidClient(config);

    const [first, second] = await Promise.all([
      clientA.getMergedMetaAndAssetCtxs(),
      clientB.getMergedMetaAndAssetCtxs(),
    ]);

    expect(first).toEqual(second);
    expect(mockPerpDexs).toHaveBeenCalledTimes(1);
    expect(mockMetaAndAssetCtxs).toHaveBeenCalledTimes(2);

    await clientA.getMergedMetaAndAssetCtxs();
    await clientB.getMergedMetaAndAssetCtxs();

    expect(mockPerpDexs).toHaveBeenCalledTimes(1);
    expect(mockMetaAndAssetCtxs).toHaveBeenCalledTimes(2);
  });

  it('coalesces perpDexs requests across separate client instances', async () => {
    const { HyperliquidClient } = await import('../../src/execution/hyperliquid/client.js');
    const config = { hyperliquid: { enabled: true } } as any;

    const clientA = new HyperliquidClient(config);
    const clientB = new HyperliquidClient(config);

    const [first, second] = await Promise.all([clientA.listPerpDexs(), clientB.listPerpDexs()]);

    expect(first).toEqual(['dexA']);
    expect(second).toEqual(['dexA']);
    expect(mockPerpDexs).toHaveBeenCalledTimes(1);
  });
});
