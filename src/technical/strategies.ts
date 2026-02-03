import type { Strategy, TradeSignal, StrategyPosition } from './types.js';

export const trendFollowing: Strategy = {
  name: 'trend_following',
  description: 'Enter on pullbacks in established trends',
  timeframes: ['4h', '1d'],
  shouldEnter(signal: TradeSignal): boolean {
    return (
      signal.confidence > 0.6 &&
      signal.technicalScore > 0.3 &&
      signal.newsScore > -0.3
    );
  },
  shouldExit(position: StrategyPosition, signal: TradeSignal): boolean {
    const direction = position.direction === 'long' ? 1 : -1;
    return signal.direction === 'neutral' || signal.technicalScore * direction < 0;
  },
  maxPositionSize: 0.1,
  stopLossPercent: 0.03,
  takeProfitPercent: [0.05, 0.1, 0.15],
};

export const meanReversion: Strategy = {
  name: 'mean_reversion',
  description: 'Fade extreme moves with confirmation',
  timeframes: ['1h', '4h'],
  shouldEnter(signal: TradeSignal): boolean {
    return signal.confidence > 0.5 && Math.abs(signal.technicalScore) > 0.4 && Math.abs(signal.newsScore) < 0.3;
  },
  shouldExit(_position: StrategyPosition, signal: TradeSignal): boolean {
    return signal.direction === 'neutral';
  },
  maxPositionSize: 0.05,
  stopLossPercent: 0.02,
  takeProfitPercent: [0.02, 0.03],
};

export const newsCatalyst: Strategy = {
  name: 'news_catalyst',
  description: 'Trade technical setups triggered by news',
  timeframes: ['15m', '1h'],
  shouldEnter(signal: TradeSignal): boolean {
    return (
      Math.abs(signal.newsScore) > 0.5 &&
      Math.sign(signal.newsScore) === Math.sign(signal.technicalScore) &&
      Math.sign(signal.newsScore) === Math.sign(signal.onChainScore)
    );
  },
  shouldExit(position: StrategyPosition, signal: TradeSignal): boolean {
    const direction = position.direction === 'long' ? 1 : -1;
    return signal.newsScore * direction < 0 || signal.technicalScore * direction < -0.2;
  },
  maxPositionSize: 0.08,
  stopLossPercent: 0.025,
  takeProfitPercent: [0.04, 0.08],
};

export const STRATEGIES: Strategy[] = [trendFollowing, meanReversion, newsCatalyst];

export function getStrategy(name: string): Strategy | undefined {
  const normalized = name.toLowerCase().replace(/\s+/g, '_');
  return STRATEGIES.find((strategy) => strategy.name === normalized);
}
