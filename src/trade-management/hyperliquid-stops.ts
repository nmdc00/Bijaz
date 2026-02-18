import type { ExchangeClient } from '@nktkas/hyperliquid';
import { formatPrice } from '@nktkas/hyperliquid/utils';
import { randomBytes } from 'node:crypto';

export type BracketSide = 'long' | 'short';

export type BracketParams = {
  symbol: string;
  side: BracketSide;
  size: number;
  entryPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
};

export type HyperliquidMarketMeta = {
  symbol: string;
  assetId: number;
  szDecimals: number;
};

export function makeCloid(): string {
  return `0x${randomBytes(16).toString('hex')}`;
}

export function computeBracketPrices(params: {
  side: BracketSide;
  entryPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
}): { slPx: number; tpPx: number } {
  const entry = params.entryPrice;
  const slMul = 1 - Math.abs(params.stopLossPct) / 100;
  const tpMul = 1 + Math.abs(params.takeProfitPct) / 100;
  if (params.side === 'long') {
    return { slPx: entry * slMul, tpPx: entry * tpMul };
  }
  // For shorts, SL is above entry; TP is below.
  return { slPx: entry * tpMul, tpPx: entry * slMul };
}

export async function placeExchangeSideTpsl(params: {
  exchange: ExchangeClient;
  market: HyperliquidMarketMeta;
  bracket: BracketParams;
  slCloid: string;
  tpCloid: string;
}): Promise<void> {
  const { slPx, tpPx } = computeBracketPrices({
    side: params.bracket.side,
    entryPrice: params.bracket.entryPrice,
    stopLossPct: params.bracket.stopLossPct,
    takeProfitPct: params.bracket.takeProfitPct,
  });

  // HL requires string decimals.
  const sizeStr = formatDecimal(params.bracket.size, params.market.szDecimals);
  const slStr = formatPerpPrice(slPx, params.market.szDecimals);
  const tpStr = formatPerpPrice(tpPx, params.market.szDecimals);

  // Close direction is opposite of the position direction.
  const closeIsBuy = params.bracket.side === 'short';

  await params.exchange.order({
    orders: [
      {
        a: params.market.assetId,
        b: closeIsBuy,
        p: slStr,
        s: sizeStr,
        r: true,
        t: { trigger: { isMarket: true, triggerPx: slStr, tpsl: 'sl' } },
        c: params.slCloid,
      },
      {
        a: params.market.assetId,
        b: closeIsBuy,
        p: tpStr,
        s: sizeStr,
        r: true,
        t: { trigger: { isMarket: true, triggerPx: tpStr, tpsl: 'tp' } },
        c: params.tpCloid,
      },
    ],
    grouping: 'positionTpsl',
  } as any);
}

function formatDecimal(value: number, decimals: number): string {
  const bounded = Math.max(0, value);
  const fixed = bounded.toFixed(decimals);
  return fixed.replace(/\.?0+$/, '');
}

function formatPerpPrice(price: number, szDecimals: number): string {
  try {
    return formatPrice(price, szDecimals, 'perp');
  } catch {
    return formatDecimal(price, 8);
  }
}
