import type { Market } from '../execution/markets.js';
import type { TradeSignal } from './types.js';

export interface AugurBetDecision {
  action: 'bet' | 'skip';
  outcome?: 'YES' | 'NO';
  size?: number;
  marketId?: string;
  reason: string;
}

function timeframeToHours(timeframe: TradeSignal['timeframe']): number {
  switch (timeframe) {
    case '1m':
    case '5m':
    case '15m':
      return 6;
    case '1h':
      return 12;
    case '4h':
      return 24;
    case '1d':
      return 72;
    default:
      return 24;
  }
}

export function mapSignalToAugurMarket(
  signal: TradeSignal,
  markets: Market[]
): AugurBetDecision {
  const candidates = markets.filter((market) => market.platform === 'augur' && market.augur?.type === 'crypto');
  if (candidates.length === 0) {
    return { action: 'skip', reason: 'No Augur crypto markets available.' };
  }

  const maxHours = timeframeToHours(signal.timeframe);
  const now = Date.now();
  const withStrike = candidates.filter(
    (market) => market.augur?.creationPrice != null && market.endDate != null
  );

  const filtered = withStrike.filter((market) => {
    const expiry = market.endDate ? market.endDate.getTime() : 0;
    if (!expiry || expiry < now) return false;
    const hoursToExpiry = (expiry - now) / (1000 * 60 * 60);
    return hoursToExpiry <= maxHours;
  });

  if (filtered.length === 0) {
    return { action: 'skip', reason: 'No suitable Augur market within signal timeframe.' };
  }

  const sorted = filtered.sort((a, b) => {
    const aExpiry = a.endDate ? a.endDate.getTime() : 0;
    const bExpiry = b.endDate ? b.endDate.getTime() : 0;
    return aExpiry - bExpiry;
  });

  const market = sorted[0]!;
  const strike = market.augur?.creationPrice ?? 0;
  if (!strike || signal.entryPrice <= 0) {
    return { action: 'skip', reason: 'Missing strike price or entry price.' };
  }

  const betOnYes = signal.direction === 'long' && signal.entryPrice < strike;
  const betOnNo = signal.direction === 'short' && signal.entryPrice > strike;

  if (!betOnYes && !betOnNo) {
    return { action: 'skip', reason: 'Signal direction does not match strike setup.' };
  }

  const size = signal.positionSize;
  return {
    action: 'bet',
    outcome: betOnYes ? 'YES' : 'NO',
    size,
    marketId: market.id,
    reason: `Signal ${signal.direction} vs strike ${strike.toFixed(2)}`,
  };
}
