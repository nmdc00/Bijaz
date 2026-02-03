# Technical Analysis Pivot for Short-Term Trading

> Extending Thufir from event-driven prediction markets to short-term crypto trading with technical analysis.

## Overview

**Current Thufir:** News/intel → Event prediction → Bet on outcomes (days/weeks)

**Pivoted Thufir:** Technical signals + News catalyst → Short-term price direction → Trade (hours/days)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        THUFIR CORE                              │
├─────────────────────┬───────────────────────────────────────────┤
│   INTEL LAYER       │         TECHNICAL LAYER (NEW)            │
│   (existing)        │                                           │
│                     │  ┌─────────────┐  ┌──────────────────┐   │
│  • News APIs        │  │ Price Feeds │  │ Technical        │   │
│  • RSS feeds        │  │ (OHLCV)     │  │ Indicators       │   │
│  • Twitter/X        │  └─────────────┘  └──────────────────┘   │
│  • Google News      │                                           │
│                     │  ┌─────────────┐  ┌──────────────────┐   │
│                     │  │ On-Chain    │  │ Pattern          │   │
│                     │  │ Data        │  │ Recognition      │   │
│                     │  └─────────────┘  └──────────────────┘   │
├─────────────────────┴───────────────────────────────────────────┤
│                     SIGNAL FUSION                               │
│         Technical Signal + News Catalyst = Trade Decision       │
├─────────────────────────────────────────────────────────────────┤
│                     EXECUTION LAYER                             │
│    Augur Turbo (crypto markets) / DEX / CEX API                │
└─────────────────────────────────────────────────────────────────┘
```

## Components Needed

### 1. Price Data Service (`src/technical/prices.ts`)

**Purpose:** Fetch and cache OHLCV data across multiple timeframes.

**Data Sources (free tiers available):**
| Source | Endpoint | Rate Limit | Notes |
|--------|----------|------------|-------|
| CoinGecko | `/coins/{id}/ohlc` | 10-50/min | Free, good for daily |
| Binance | `/api/v3/klines` | 1200/min | Best for minute data |
| CryptoCompare | `/data/v2/histohour` | 100k/month | Historical depth |
| CoinCap | `api.coincap.io/v2` | 200/min | WebSocket available |

**Schema:**
```typescript
interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface PriceService {
  // Fetch candles for a symbol
  getCandles(symbol: string, timeframe: Timeframe, limit?: number): Promise<OHLCV[]>;

  // Subscribe to real-time price updates
  subscribe(symbol: string, callback: (price: number) => void): () => void;

  // Get current price
  getPrice(symbol: string): Promise<number>;
}

type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
```

**Implementation:**
```typescript
// Using CCXT for unified exchange API
import ccxt from 'ccxt';

const exchange = new ccxt.binance({ enableRateLimit: true });

async function getCandles(symbol: string, timeframe: string, limit = 100): Promise<OHLCV[]> {
  const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  return ohlcv.map(([timestamp, open, high, low, close, volume]) => ({
    timestamp, open, high, low, close, volume
  }));
}
```

---

### 2. Technical Indicators (`src/technical/indicators.ts`)

**Library:** Use `technicalindicators` npm package (pure JS, no native deps)

```bash
pnpm add technicalindicators
```

**Core Indicators to Implement:**

| Category | Indicator | Signal |
|----------|-----------|--------|
| **Trend** | SMA/EMA (20, 50, 200) | Price above/below MA |
| | MACD | Crossovers, divergence |
| | ADX | Trend strength (>25 = trending) |
| **Momentum** | RSI (14) | Overbought >70, Oversold <30 |
| | Stochastic | %K/%D crossovers |
| **Volatility** | Bollinger Bands | Squeeze, breakout |
| | ATR | Position sizing, stops |
| **Volume** | OBV | Confirm price moves |
| | VWAP | Intraday fair value |

**Schema:**
```typescript
interface IndicatorResult {
  name: string;
  value: number | number[];
  signal: 'bullish' | 'bearish' | 'neutral';
  strength: number; // 0-1
}

interface TechnicalSnapshot {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  price: number;
  indicators: IndicatorResult[];
  overallBias: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
}
```

**Implementation:**
```typescript
import { RSI, MACD, BollingerBands, SMA, EMA } from 'technicalindicators';

function calculateIndicators(candles: OHLCV[]): IndicatorResult[] {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const results: IndicatorResult[] = [];

  // RSI
  const rsi = RSI.calculate({ values: closes, period: 14 });
  const currentRsi = rsi[rsi.length - 1];
  results.push({
    name: 'RSI',
    value: currentRsi,
    signal: currentRsi > 70 ? 'bearish' : currentRsi < 30 ? 'bullish' : 'neutral',
    strength: Math.abs(50 - currentRsi) / 50,
  });

  // MACD
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const currentMacd = macd[macd.length - 1];
  results.push({
    name: 'MACD',
    value: [currentMacd.MACD, currentMacd.signal, currentMacd.histogram],
    signal: currentMacd.histogram > 0 ? 'bullish' : 'bearish',
    strength: Math.min(Math.abs(currentMacd.histogram) / 100, 1),
  });

  // Bollinger Bands
  const bb = BollingerBands.calculate({
    values: closes,
    period: 20,
    stdDev: 2,
  });
  const currentBb = bb[bb.length - 1];
  const currentPrice = closes[closes.length - 1];
  const bbPosition = (currentPrice - currentBb.lower) / (currentBb.upper - currentBb.lower);
  results.push({
    name: 'Bollinger',
    value: [currentBb.lower, currentBb.middle, currentBb.upper],
    signal: bbPosition < 0.2 ? 'bullish' : bbPosition > 0.8 ? 'bearish' : 'neutral',
    strength: Math.abs(0.5 - bbPosition) * 2,
  });

  // Moving Averages
  const sma20 = SMA.calculate({ values: closes, period: 20 });
  const sma50 = SMA.calculate({ values: closes, period: 50 });
  const currentSma20 = sma20[sma20.length - 1];
  const currentSma50 = sma50[sma50.length - 1];
  results.push({
    name: 'MA_Cross',
    value: [currentSma20, currentSma50],
    signal: currentSma20 > currentSma50 ? 'bullish' : 'bearish',
    strength: Math.min(Math.abs(currentSma20 - currentSma50) / currentPrice * 10, 1),
  });

  return results;
}
```

---

### 3. On-Chain Data (`src/technical/onchain.ts`)

**Purpose:** Whale movements, exchange flows, liquidation levels.

**Data Sources:**
| Source | Data | API |
|--------|------|-----|
| Glassnode | Exchange flows, whale alerts | Paid |
| CryptoQuant | Exchange reserves, miner flows | Paid |
| Whale Alert | Large transactions | Free tier |
| DefiLlama | TVL, protocol flows | Free |
| Coinglass | Funding rates, liquidations, OI | Free tier |

**Free/Cheap Options:**
```typescript
// Coinglass (free tier for basic data)
interface FundingRate {
  symbol: string;
  rate: number;  // Positive = longs pay shorts
  nextFundingTime: number;
}

interface OpenInterest {
  symbol: string;
  openInterest: number;
  change24h: number;
}

interface LiquidationLevel {
  price: number;
  longLiquidations: number;
  shortLiquidations: number;
}

// Whale Alert (free tier)
interface WhaleTransaction {
  blockchain: string;
  symbol: string;
  amount: number;
  amountUsd: number;
  from: { owner: string; owner_type: string };
  to: { owner: string; owner_type: string };
  timestamp: number;
}
```

**Signals from On-Chain:**
| Data | Bullish Signal | Bearish Signal |
|------|----------------|----------------|
| Funding rate | Very negative (<-0.01%) | Very positive (>0.05%) |
| Exchange inflow | Low/decreasing | High/spiking |
| Whale txns | Accumulation (exchange→wallet) | Distribution (wallet→exchange) |
| Open interest | Rising with price | Rising against price (divergence) |
| Liquidation levels | Large shorts clustered above | Large longs clustered below |

---

### 4. Signal Fusion (`src/technical/signals.ts`)

**Purpose:** Combine technical indicators + news sentiment into actionable signals.

```typescript
interface TradeSignal {
  symbol: string;
  direction: 'long' | 'short' | 'neutral';
  confidence: number;      // 0-1
  timeframe: Timeframe;

  // Components
  technicalScore: number;  // -1 to 1
  newsScore: number;       // -1 to 1 (from existing intel layer)
  onChainScore: number;    // -1 to 1

  // Risk management
  entryPrice: number;
  stopLoss: number;
  takeProfit: number[];    // Multiple targets
  riskRewardRatio: number;
  positionSize: number;    // Based on ATR and account risk

  // Reasoning
  technicalReasoning: string[];
  newsReasoning: string[];
  onChainReasoning: string[];
}

function fuseSignals(
  technical: TechnicalSnapshot,
  news: NewsSentiment,
  onChain: OnChainSnapshot
): TradeSignal {
  // Weight the signals
  const weights = {
    technical: 0.5,
    news: 0.3,
    onChain: 0.2,
  };

  const technicalScore = calculateTechnicalScore(technical);
  const newsScore = news.sentiment; // -1 to 1
  const onChainScore = calculateOnChainScore(onChain);

  const combinedScore =
    technicalScore * weights.technical +
    newsScore * weights.news +
    onChainScore * weights.onChain;

  // Only trade when signals align
  const signalsAligned =
    Math.sign(technicalScore) === Math.sign(newsScore) &&
    Math.sign(technicalScore) === Math.sign(onChainScore);

  const confidence = signalsAligned
    ? Math.abs(combinedScore)
    : Math.abs(combinedScore) * 0.5; // Reduce confidence when mixed

  return {
    symbol: technical.symbol,
    direction: combinedScore > 0.2 ? 'long' : combinedScore < -0.2 ? 'short' : 'neutral',
    confidence,
    timeframe: technical.timeframe,
    technicalScore,
    newsScore,
    onChainScore,
    // ... calculate risk management params
  };
}
```

---

### 5. Strategy Framework (`src/technical/strategies.ts`)

**Purpose:** Predefined trading strategies that combine signals.

```typescript
interface Strategy {
  name: string;
  description: string;
  timeframes: Timeframe[];

  // Entry conditions
  shouldEnter(signal: TradeSignal): boolean;

  // Exit conditions
  shouldExit(position: Position, currentSignal: TradeSignal): boolean;

  // Risk parameters
  maxPositionSize: number;
  stopLossPercent: number;
  takeProfitPercent: number[];
}

// Example: Trend Following Strategy
const trendFollowing: Strategy = {
  name: 'Trend Following',
  description: 'Enter on pullbacks in established trends',
  timeframes: ['4h', '1d'],

  shouldEnter(signal) {
    // Enter when:
    // 1. Higher timeframe trend is clear (ADX > 25, price above MA50)
    // 2. RSI pulls back to 40-50 in uptrend (or 50-60 in downtrend)
    // 3. News sentiment not strongly against
    return (
      signal.confidence > 0.6 &&
      signal.technicalScore > 0.3 &&
      signal.newsScore > -0.3
    );
  },

  shouldExit(position, signal) {
    // Exit when trend reverses or target hit
    return (
      signal.direction !== position.direction ||
      signal.technicalScore < 0
    );
  },

  maxPositionSize: 0.1, // 10% of portfolio
  stopLossPercent: 0.03, // 3%
  takeProfitPercent: [0.05, 0.10, 0.15], // Scale out at 5%, 10%, 15%
};

// Example: Mean Reversion Strategy
const meanReversion: Strategy = {
  name: 'Mean Reversion',
  description: 'Fade extreme moves with confirmation',
  timeframes: ['1h', '4h'],

  shouldEnter(signal) {
    // Enter when:
    // 1. RSI extreme (<25 or >75)
    // 2. Price at Bollinger Band extreme
    // 3. No strong news catalyst driving move
    const rsi = signal.technicalReasoning.find(r => r.includes('RSI'));
    return (
      signal.confidence > 0.5 &&
      Math.abs(signal.technicalScore) > 0.4 &&
      Math.abs(signal.newsScore) < 0.3 // News not driving
    );
  },

  shouldExit(position, signal) {
    return signal.direction === 'neutral'; // Exit at mean
  },

  maxPositionSize: 0.05, // 5% - smaller for mean reversion
  stopLossPercent: 0.02,
  takeProfitPercent: [0.02, 0.03],
};

// Example: News Catalyst Strategy (leverages existing intel)
const newsCatalyst: Strategy = {
  name: 'News Catalyst',
  description: 'Trade technical setups triggered by news',
  timeframes: ['15m', '1h'],

  shouldEnter(signal) {
    // Enter when:
    // 1. Significant news event (high news score)
    // 2. Technical setup supports direction
    // 3. On-chain confirms (no whale selling into news)
    return (
      Math.abs(signal.newsScore) > 0.5 && // Strong news
      Math.sign(signal.newsScore) === Math.sign(signal.technicalScore) &&
      Math.sign(signal.newsScore) === Math.sign(signal.onChainScore)
    );
  },

  shouldExit(position, signal) {
    return (
      signal.newsScore * position.direction < 0 || // News flipped
      signal.technicalScore * position.direction < -0.2 // Technical breakdown
    );
  },

  maxPositionSize: 0.08,
  stopLossPercent: 0.025,
  takeProfitPercent: [0.04, 0.08],
};
```

---

### 6. Execution Target: Augur Turbo Crypto Markets

Augur Turbo's crypto markets are essentially: "Will BTC/ETH be above price X at time Y?"

This maps well to short-term technical analysis:
- 4h/daily timeframe signals → bet on price direction
- Entry signal → buy Yes/No shares on Augur
- Exit via market or wait for resolution

```typescript
// Map technical signal to Augur Turbo bet
function signalToAugurBet(
  signal: TradeSignal,
  market: AugurCryptoMarket
): AugurBetDecision {
  const currentPrice = signal.entryPrice;
  const targetPrice = market.strikePrice;
  const expiryHours = (market.endTime - Date.now()) / (1000 * 60 * 60);

  // Decide Yes (above strike) or No (below strike)
  const betOnYes = signal.direction === 'long' && currentPrice < targetPrice;
  const betOnNo = signal.direction === 'short' && currentPrice > targetPrice;

  if (!betOnYes && !betOnNo) {
    return { action: 'skip', reason: 'Signal doesn\'t match market' };
  }

  // Size based on confidence and time to expiry
  const baseSize = signal.confidence * maxBetSize;
  const timeDecay = Math.max(0.5, expiryHours / 24); // Reduce size as expiry nears

  return {
    action: 'bet',
    outcome: betOnYes ? 'Yes' : 'No',
    size: baseSize * timeDecay,
    reasoning: {
      technical: signal.technicalReasoning,
      news: signal.newsReasoning,
      direction: signal.direction,
      confidence: signal.confidence,
    },
  };
}
```

---

## Implementation Phases

### Phase 1: Price Data + Basic Indicators (1-2 days)
- [x] Add CCXT for exchange data
- [x] Implement PriceService with caching
- [x] Add `technicalindicators` package
- [x] Basic indicator calculations (RSI, MACD, MA, BB)
- [x] CLI command: `thufir ta <symbol>` - show technical snapshot

### Phase 2: Signal Generation (1-2 days)
- [x] TechnicalSnapshot generation
- [x] Signal scoring algorithm
- [x] Combine with existing news sentiment (lightweight keyword sentiment)
- [x] CLI command: `thufir signals` - show current signals

### Phase 3: On-Chain Data (1 day)
- [ ] Coinglass integration (funding, OI, liquidations)
- [ ] Whale Alert integration (optional)
- [x] On-chain signal scoring (neutral placeholder)
- [x] Add to signal fusion (neutral when disabled)

### Phase 4: Strategy Framework (1-2 days)
- [x] Strategy interface
- [x] Implement 2-3 basic strategies
- [ ] Backtesting framework (optional but useful)
- [x] CLI command: `thufir strategy <name>` - run strategy scan

### Phase 5: Augur Integration (1-2 days)
- [x] Map signals to Augur crypto markets (basic strike/timeframe match)
- [x] Implement AugurLiveExecutor
- [ ] End-to-end flow: Signal → Bet decision → Execute

### Phase 6: Monitoring + Calibration (ongoing)
- [ ] Track signal accuracy
- [ ] Adjust weights based on performance
- [ ] Add to existing calibration system

---

## Dependencies to Add

```json
{
  "dependencies": {
    "ccxt": "^4.2.0",
    "technicalindicators": "^3.1.0"
  }
}
```

**CCXT:** Unified API for 100+ exchanges (Binance, Coinbase, Kraken, etc.)
**technicalindicators:** Pure JS technical analysis library

---

## Config Schema Updates

```yaml
technical:
  enabled: true

  # Price data
  priceSource: 'binance'  # or 'coinbase', 'coingecko'
  symbols:
    - 'BTC/USDT'
    - 'ETH/USDT'

  # Timeframes to analyze
  timeframes:
    - '1h'
    - '4h'
    - '1d'

  # Indicator settings
  indicators:
    rsi:
      period: 14
      overbought: 70
      oversold: 30
    macd:
      fast: 12
      slow: 26
      signal: 9
    bollingerBands:
      period: 20
      stdDev: 2

  # Signal thresholds
  signals:
    minConfidence: 0.5
    weights:
      technical: 0.5
      news: 0.3
      onChain: 0.2

  # On-chain data (optional)
  onChain:
    enabled: true
    coinglassApiKey: '${COINGLASS_API_KEY}'
```

---

## Summary

| Component | Purpose | Effort |
|-----------|---------|--------|
| Price Service | OHLCV data via CCXT | 1 day |
| Indicators | RSI, MACD, BB, MA | 1 day |
| Signal Fusion | Combine TA + news + on-chain | 1 day |
| On-Chain Data | Funding, OI, whale alerts | 1 day |
| Strategies | Predefined trading rules | 1-2 days |
| Augur Execution | Map signals to crypto markets | 1-2 days |
| **Total** | | **6-9 days** |

This pivot keeps Thufir's existing intel layer (news) but adds technical analysis as the primary signal generator, with news as a confirming/catalyst factor.
