import type { Market } from '../markets.js';
import type { AugurMarket } from './client.js';

export function normalizeAugurMarket(raw: AugurMarket): Market {
  const prices: Record<string, number> = {
    YES: raw.prices[0] ?? 0.5,
    NO: raw.prices[1] ?? 0.5,
  };
  return {
    id: raw.id,
    question: buildQuestion(raw),
    description: undefined,
    outcomes: ['YES', 'NO'],
    prices,
    volume: undefined,
    liquidity: undefined,
    endDate: raw.endTime ? new Date(raw.endTime * 1000) : undefined,
    category: raw.type,
    resolved: raw.winner != null,
    resolution: raw.winner ?? undefined,
    createdAt: new Date(),
    platform: 'augur',
    augur: {
      marketFactory: raw.marketFactory,
      marketIndex: raw.marketIndex,
      type: raw.type,
      shareTokens: raw.shareTokens,
      coinIndex: raw.coinIndex,
      creationPrice: raw.creationPrice,
      marketType: raw.marketType,
    },
  };
}

function buildQuestion(raw: AugurMarket): string {
  if (raw.type === 'crypto') {
    if (raw.creationPrice != null) {
      const strike = Number.isFinite(raw.creationPrice)
        ? raw.creationPrice.toLocaleString('en-US')
        : raw.creationPrice;
      return `Will crypto market ${raw.marketIndex} resolve YES above ${strike}?`;
    }
    return `Will crypto market ${raw.marketIndex} resolve YES?`;
  }
  if (raw.type === 'sports') {
    return `Will market ${raw.marketIndex} resolve YES?`;
  }
  return `Will market ${raw.marketIndex} resolve YES?`;
}
