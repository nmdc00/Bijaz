export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorResult {
  name: string;
  value: number | number[];
  signal: 'bullish' | 'bearish' | 'neutral';
  strength: number;
}

export interface TechnicalSnapshot {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  price: number;
  indicators: IndicatorResult[];
  overallBias: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
}

export interface NewsSentiment {
  sentiment: number;
  reasoning: string[];
  matchedItems: Array<{
    title: string;
    source: string;
    timestamp: string;
    score: number;
  }>;
}

export interface OnChainSnapshot {
  score: number;
  reasoning: string[];
}

export interface TradeSignal {
  symbol: string;
  direction: 'long' | 'short' | 'neutral';
  confidence: number;
  timeframe: Timeframe;
  technicalScore: number;
  newsScore: number;
  onChainScore: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number[];
  riskRewardRatio: number;
  positionSize: number;
  technicalReasoning: string[];
  newsReasoning: string[];
  onChainReasoning: string[];
}

export interface StrategyPosition {
  direction: 'long' | 'short';
  entryPrice: number;
  size: number;
}

export interface Strategy {
  name: string;
  description: string;
  timeframes: Timeframe[];
  shouldEnter(signal: TradeSignal): boolean;
  shouldExit(position: StrategyPosition, signal: TradeSignal): boolean;
  maxPositionSize: number;
  stopLossPercent: number;
  takeProfitPercent: number[];
}
