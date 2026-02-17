import { describe, it, expect } from 'vitest';

import { computeBracketPrices, makeCloid, placeExchangeSideTpsl } from '../../src/trade-management/hyperliquid-stops.js';

describe('hyperliquid stops', () => {
  it('computes bracket prices for long', () => {
    const { slPx, tpPx } = computeBracketPrices({
      side: 'long',
      entryPrice: 100,
      stopLossPct: 3,
      takeProfitPct: 5,
    });
    expect(slPx).toBeCloseTo(97);
    expect(tpPx).toBeCloseTo(105);
  });

  it('computes bracket prices for short', () => {
    const { slPx, tpPx } = computeBracketPrices({
      side: 'short',
      entryPrice: 100,
      stopLossPct: 3,
      takeProfitPct: 5,
    });
    expect(slPx).toBeCloseTo(105);
    expect(tpPx).toBeCloseTo(97);
  });

  it('generates valid cloids', () => {
    const id = makeCloid();
    expect(id).toMatch(/^0x[0-9a-f]{32}$/);
    expect(id.length).toBe(34);
  });

  it('places grouped positionTpsl trigger orders', async () => {
    const calls: any[] = [];
    const exchange = {
      order: async (payload: any) => {
        calls.push(payload);
        return { status: 'ok' };
      },
    } as any;

    const slCloid = makeCloid();
    const tpCloid = makeCloid();
    await placeExchangeSideTpsl({
      exchange,
      market: { symbol: 'BTC', assetId: 1, szDecimals: 2 },
      bracket: {
        symbol: 'BTC',
        side: 'long',
        size: 1.23,
        entryPrice: 100,
        stopLossPct: 3,
        takeProfitPct: 5,
      },
      slCloid,
      tpCloid,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.grouping).toBe('positionTpsl');
    expect(calls[0]!.orders.length).toBe(2);
    expect(calls[0]!.orders[0]!.t.trigger.tpsl).toBe('sl');
    expect(calls[0]!.orders[1]!.t.trigger.tpsl).toBe('tp');
    expect(calls[0]!.orders[0]!.c).toBe(slCloid);
    expect(calls[0]!.orders[1]!.c).toBe(tpCloid);
    // Long close is sell.
    expect(calls[0]!.orders[0]!.b).toBe(false);
  });
});

