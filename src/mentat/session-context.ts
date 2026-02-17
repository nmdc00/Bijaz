import type { Market } from '../execution/markets.js';

export type MarketSession = 'asia' | 'europe' | 'us' | 'offhours' | 'weekend';
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

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function resolveUtcDate(at?: Date | string): Date {
  if (!at) return new Date();
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? new Date() : at;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function resolveSession(date: Date): MarketSession {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return 'weekend';

  const hour = date.getUTCHours();
  if (hour >= 0 && hour < 8) return 'asia';
  if (hour >= 8 && hour < 13) return 'europe';
  if (hour >= 13 && hour < 21) return 'us';
  return 'offhours';
}

function baselineWeight(session: MarketSession): number {
  switch (session) {
    case 'us':
      return 1;
    case 'europe':
      return 0.9;
    case 'asia':
      return 0.8;
    case 'offhours':
      return 0.7;
    case 'weekend':
      return 0.6;
  }
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
    if (session === 'us') return { regime: 'normal', hasMetadata: false };
    if (session === 'offhours') return { regime: 'thin', hasMetadata: false };
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

function liquidityModifier(regime: LiquidityRegime): number {
  switch (regime) {
    case 'deep':
      return 0.05;
    case 'normal':
      return 0;
    case 'thin':
      return -0.12;
  }
}

function buildQualityNotes(
  session: MarketSession,
  liquidityRegime: LiquidityRegime,
  hasMetadata: boolean
): string[] {
  const notes: string[] = [];
  if (session === 'weekend') notes.push('Weekend session: broad crypto liquidity is typically reduced.');
  if (session === 'us') notes.push('US session window: price discovery is generally strongest.');
  if (session === 'offhours') notes.push('Off-hours session: spreads and slippage risk can increase.');
  if (!hasMetadata) notes.push('Limited market volume/liquidity metadata; applied conservative defaults.');
  if (liquidityRegime === 'thin') notes.push('Detected thin liquidity regime from current market metadata.');
  if (liquidityRegime === 'deep') notes.push('Detected deep liquidity regime from current market metadata.');
  if (notes.length === 0) notes.push('Session and liquidity conditions are within expected baseline.');
  return notes;
}

export function deriveSessionContext(options: DeriveSessionContextOptions = {}): SessionContext {
  const date = resolveUtcDate(options.at);
  const session = resolveSession(date);
  const markets = options.markets ?? [];
  const liquidity = inferLiquidityRegime(session, markets);
  const sessionWeight = clamp(baselineWeight(session) + liquidityModifier(liquidity.regime), 0.4, 1);

  return {
    session,
    liquidityRegime: liquidity.regime,
    qualityNotes: buildQualityNotes(session, liquidity.regime, liquidity.hasMetadata),
    sessionWeight,
  };
}

