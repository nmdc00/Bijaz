import type { Market } from '../execution/markets.js';
import {
  resolveSessionWeightContext,
  type SessionBucket as MarketSession,
} from '../core/session-weight.js';

export type { MarketSession };
export type LiquidityRegime = 'deep' | 'normal' | 'thin';

export interface SessionContext {
  session: MarketSession;
  liquidityRegime: LiquidityRegime;
  qualityNotes: string[];
  sessionWeight: number;
}

interface DeriveSessionContextOptions {
  at?: Date | string;
  markets?: Market[];
}

function inferLiquidityRegime(session: MarketSession, markets: Market[]): {
  regime: LiquidityRegime;
  hasMetadata: boolean;
} {
  const pairs = markets
    .map((market) => {
      const volume = typeof market.volume === 'number' && Number.isFinite(market.volume) ? market.volume : null;
      const liquidity =
        typeof market.liquidity === 'number' && Number.isFinite(market.liquidity) ? market.liquidity : null;
      if (volume == null || liquidity == null) return null;
      return { volume, liquidity };
    })
    .filter((pair): pair is { volume: number; liquidity: number } => pair != null);

  if (session === 'weekend') {
    return { regime: 'thin', hasMetadata: pairs.length > 0 };
  }

  if (pairs.length === 0) {
    return { regime: 'normal', hasMetadata: false };
  }

  const avgVolume = pairs.reduce((sum, item) => sum + item.volume, 0) / pairs.length;
  const avgLiquidity = pairs.reduce((sum, item) => sum + item.liquidity, 0) / pairs.length;
  const volumeToLiquidity = avgLiquidity > 0 ? avgVolume / avgLiquidity : 0;

  if (avgLiquidity < 50_000 || avgVolume < 75_000 || volumeToLiquidity > 6) {
    return { regime: 'thin', hasMetadata: true };
  }
  if (avgLiquidity > 250_000 && avgVolume > 300_000 && volumeToLiquidity < 3) {
    return { regime: 'deep', hasMetadata: true };
  }
  return { regime: 'normal', hasMetadata: true };
}

function buildQualityNotes(
  session: MarketSession,
  liquidityRegime: LiquidityRegime,
  hasMetadata: boolean
): string[] {
  const notes: string[] = [];
  if (session === 'weekend') notes.push('Weekend session: broad crypto liquidity is typically reduced.');
  if (session === 'us_open') notes.push('US open session: price discovery is generally strongest.');
  if (session === 'us_midday') notes.push('US midday session: mean-reversion and chop can increase.');
  if (session === 'us_close') notes.push('US close session: late-day flow can become noisy.');
  if (session === 'asia') notes.push('Asia session: follow-through can be thinner versus US open hours.');
  if (session === 'europe_open') notes.push('Europe open session: trend discovery often improves from overnight baselines.');
  if (!hasMetadata) notes.push('Limited market volume/liquidity metadata; applied conservative defaults.');
  if (liquidityRegime === 'thin') notes.push('Detected thin liquidity regime from current market metadata.');
  if (liquidityRegime === 'deep') notes.push('Detected deep liquidity regime from current market metadata.');
  if (notes.length === 0) notes.push('Session and liquidity conditions are within expected baseline.');
  return notes;
}

export function deriveSessionContext(options: DeriveSessionContextOptions = {}): SessionContext {
  const markets = options.markets ?? [];
  const sessionContext = resolveSessionWeightContext(options.at);
  const liquidity = inferLiquidityRegime(sessionContext.session, markets);

  return {
    session: sessionContext.session,
    liquidityRegime: liquidity.regime,
    qualityNotes: buildQualityNotes(sessionContext.session, liquidity.regime, liquidity.hasMetadata),
    sessionWeight: sessionContext.sessionWeight,
  };
}
