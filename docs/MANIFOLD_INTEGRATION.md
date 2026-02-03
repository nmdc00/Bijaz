# Manifold Markets Integration Guide

> Integration guide for Manifold Markets - play money prediction market for calibrating Thufir's event-driven predictions.

## Why Manifold for Calibration

| Aspect | Manifold | Real Money Markets |
|--------|----------|-------------------|
| Currency | Mana (play money) | USDC/USD |
| Risk | Zero financial risk | Real losses possible |
| Market types | General events, politics, tech, culture | Varies by platform |
| API | Free, generous limits | Often restricted |
| Ideal for | Calibration, testing strategies | Production trading |

**Calibration Strategy:**
1. Run Thufir's intel-driven predictions on Manifold
2. Track Brier scores, calibration curves
3. Tune confidence thresholds and decision weights
4. Once calibrated, apply to real money markets (Augur, Augur Turbo when accessible)

## API Overview

**Base URL:** `https://api.manifold.markets/v0`

**Authentication:**
```
Authorization: Key YOUR_API_KEY
```
Get API key from: https://manifold.markets/profile → "API Key" section

**Rate Limit:** 500 requests/minute per IP

## Core Data Types

### Market (Contract)

```typescript
interface ManifoldMarket {
  id: string;
  slug: string;                    // URL-friendly identifier
  question: string;
  description: string | object;    // Can be rich text (TipTap JSON)

  creatorId: string;
  creatorUsername: string;
  creatorName: string;

  createdTime: number;             // Unix ms
  closeTime?: number;              // When betting closes
  resolutionTime?: number;         // When resolved

  mechanism: 'cpmm-1' | 'cpmm-multi-1' | 'none';
  outcomeType: 'BINARY' | 'MULTIPLE_CHOICE' | 'PSEUDO_NUMERIC' | 'POLL' | 'BOUNTIED_QUESTION';

  isResolved: boolean;
  resolution?: string;             // 'YES', 'NO', 'MKT', 'CANCEL', or answer ID
  resolutionProbability?: number;

  probability?: number;            // Current probability (0-1) for binary
  pool?: { YES: number; NO: number };

  volume: number;                  // Total mana traded
  volume24Hours: number;
  uniqueBettorCount: number;

  // For multiple choice
  answers?: ManifoldAnswer[];

  // Metadata
  visibility: 'public' | 'unlisted';
  token: 'MANA' | 'CASH';
}

interface ManifoldAnswer {
  id: string;
  text: string;
  probability: number;
  poolYes: number;
  poolNo: number;
}
```

### Bet

```typescript
interface ManifoldBet {
  id: string;
  contractId: string;
  userId: string;

  amount: number;                  // Mana spent
  shares: number;                  // Shares received
  outcome: 'YES' | 'NO' | string;  // Or answer ID for multiple choice

  probBefore: number;
  probAfter: number;

  createdTime: number;             // Unix ms

  // For limit orders
  limitProb?: number;
  isFilled?: boolean;
  isCancelled?: boolean;
  orderAmount?: number;
  fills?: Array<{ amount: number; shares: number; timestamp: number }>;
}
```

### User

```typescript
interface ManifoldUser {
  id: string;
  username: string;
  name: string;
  avatarUrl?: string;

  balance: number;                 // Current mana balance
  totalDeposits: number;

  profitCached: {
    daily: number;
    weekly: number;
    monthly: number;
    allTime: number;
  };

  createdTime: number;
  lastBetTime?: number;
}
```

## API Endpoints

### Markets

```typescript
// List markets
GET /v0/markets
  ?limit=100              // Max 1000
  &sort=created-time      // score, newest, liquidity, last-bet-time, etc.
  &order=desc
  &before=CURSOR_ID       // Pagination

// Search markets
GET /v0/search-markets
  ?term=bitcoin
  &sort=score             // relevance, newest, liquidity, etc.
  &contractType=BINARY    // BINARY, MULTIPLE_CHOICE, etc.
  &limit=20

// Get single market
GET /v0/market/[marketId]
GET /v0/slug/[marketSlug]

// Get market positions
GET /v0/market/[marketId]/positions
  ?top=10                 // Top N by profit
  &userId=USER_ID         // Specific user
```

### Betting

```typescript
// Place bet (market order)
POST /v0/bet
{
  "contractId": "abc123",
  "amount": 100,           // Mana to spend
  "outcome": "YES"         // or "NO" or answer ID
}

// Place limit order
POST /v0/bet
{
  "contractId": "abc123",
  "amount": 100,
  "outcome": "YES",
  "limitProb": 0.40        // Buy YES up to 40%
}

// Cancel limit order
POST /v0/bet/cancel/[betId]

// Sell shares
POST /v0/market/[marketId]/sell
{
  "outcome": "YES",
  "shares": 50             // Optional: sell specific amount
}
```

### User Data

```typescript
// Get authenticated user
GET /v0/me

// Get user by username
GET /v0/user/[username]

// Get portfolio
GET /v0/get-user-portfolio
  ?userId=USER_ID

// Get bets
GET /v0/bets
  ?userId=USER_ID
  &contractId=MARKET_ID
  &limit=100
```

## Implementation

### 1. Manifold Client (`src/execution/manifold/client.ts`)

```typescript
import fetch from 'node-fetch';

const BASE_URL = 'https://api.manifold.markets/v0';

export interface ManifoldClientOptions {
  apiKey: string;
}

export class ManifoldClient {
  private apiKey: string;

  constructor(options: ManifoldClientOptions) {
    this.apiKey = options.apiKey;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: object
  ): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Key ${this.apiKey}`,
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new ManifoldError(`API error: ${response.status} - ${error}`, response.status);
    }

    return response.json() as Promise<T>;
  }

  // ========== Markets ==========

  async searchMarkets(options: {
    term?: string;
    sort?: 'score' | 'newest' | 'liquidity' | 'close-date';
    contractType?: 'BINARY' | 'MULTIPLE_CHOICE';
    limit?: number;
  }): Promise<ManifoldMarket[]> {
    const params = new URLSearchParams();
    if (options.term) params.set('term', options.term);
    if (options.sort) params.set('sort', options.sort);
    if (options.contractType) params.set('contractType', options.contractType);
    if (options.limit) params.set('limit', String(options.limit));

    return this.request('GET', `/search-markets?${params}`);
  }

  async getMarket(idOrSlug: string): Promise<ManifoldMarket> {
    // Try ID first, then slug
    try {
      return await this.request('GET', `/market/${idOrSlug}`);
    } catch {
      return this.request('GET', `/slug/${idOrSlug}`);
    }
  }

  async listMarkets(options?: {
    limit?: number;
    sort?: string;
    before?: string;
  }): Promise<ManifoldMarket[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.sort) params.set('sort', options.sort);
    if (options?.before) params.set('before', options.before);

    return this.request('GET', `/markets?${params}`);
  }

  // ========== Betting ==========

  async placeBet(options: {
    contractId: string;
    amount: number;
    outcome: 'YES' | 'NO' | string;
    limitProb?: number;
  }): Promise<ManifoldBet> {
    return this.request('POST', '/bet', options);
  }

  async cancelBet(betId: string): Promise<{ success: boolean }> {
    return this.request('POST', `/bet/cancel/${betId}`);
  }

  async sellShares(options: {
    marketId: string;
    outcome: 'YES' | 'NO' | string;
    shares?: number;
  }): Promise<ManifoldBet> {
    return this.request('POST', `/market/${options.marketId}/sell`, {
      outcome: options.outcome,
      shares: options.shares,
    });
  }

  // ========== User ==========

  async getMe(): Promise<ManifoldUser> {
    return this.request('GET', '/me');
  }

  async getUser(username: string): Promise<ManifoldUser> {
    return this.request('GET', `/user/${username}`);
  }

  async getMyBets(options?: {
    contractId?: string;
    limit?: number;
  }): Promise<ManifoldBet[]> {
    const params = new URLSearchParams();
    if (options?.contractId) params.set('contractId', options.contractId);
    if (options?.limit) params.set('limit', String(options.limit));

    const user = await this.getMe();
    params.set('userId', user.id);

    return this.request('GET', `/bets?${params}`);
  }

  async getPortfolio(): Promise<{
    investmentValue: number;
    balance: number;
    totalDeposits: number;
    loanTotal: number;
    profit: number;
  }> {
    const user = await this.getMe();
    return this.request('GET', `/get-user-portfolio?userId=${user.id}`);
  }
}

export class ManifoldError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'ManifoldError';
  }
}
```

### 2. Market Normalization (`src/execution/manifold/normalize.ts`)

```typescript
import type { Market } from '../markets.js';
import type { ManifoldMarket } from './client.js';

/**
 * Convert Manifold market to common Market interface.
 */
export function normalizeManifoldMarket(m: ManifoldMarket): Market {
  // Handle different outcome types
  let prices: Record<string, number> = {};

  if (m.outcomeType === 'BINARY' && m.probability !== undefined) {
    prices = {
      YES: m.probability,
      NO: 1 - m.probability,
    };
  } else if (m.outcomeType === 'MULTIPLE_CHOICE' && m.answers) {
    for (const answer of m.answers) {
      prices[answer.text] = answer.probability;
    }
  }

  return {
    id: m.id,
    question: m.question,
    description: typeof m.description === 'string'
      ? m.description
      : extractTextFromTipTap(m.description),
    endDate: m.closeTime ? new Date(m.closeTime) : undefined,
    resolved: m.isResolved,
    resolution: m.resolution,
    prices,
    platform: 'manifold',
    manifold: {
      slug: m.slug,
      creatorUsername: m.creatorUsername,
      mechanism: m.mechanism,
      outcomeType: m.outcomeType,
      volume: m.volume,
      uniqueBettorCount: m.uniqueBettorCount,
      answers: m.answers,
    },
  };
}

function extractTextFromTipTap(content: object): string {
  // Simple text extraction from TipTap JSON
  // Full implementation would walk the JSON tree
  return JSON.stringify(content).replace(/<[^>]*>/g, '').slice(0, 500);
}
```

### 3. Execution Adapter (`src/execution/modes/manifold-live.ts`)

```typescript
import type { ExecutionAdapter, TradeDecision, TradeResult } from '../executor.js';
import type { Market } from '../markets.js';
import { ManifoldClient } from '../manifold/client.js';
import { createPrediction, recordExecution } from '../../memory/predictions.js';
import { recordTrade } from '../../memory/trades.js';

export class ManifoldExecutor implements ExecutionAdapter {
  private client: ManifoldClient;

  constructor(apiKey: string) {
    this.client = new ManifoldClient({ apiKey });
  }

  async execute(market: Market, decision: TradeDecision): Promise<TradeResult> {
    if (decision.action === 'hold') {
      return { executed: false, message: 'Hold decision; no trade executed.' };
    }

    if (!decision.amount || !decision.outcome) {
      return { executed: false, message: 'Invalid decision: missing amount or outcome.' };
    }

    // Create prediction record
    const predictionId = createPrediction({
      marketId: market.id,
      marketTitle: market.question,
      predictedOutcome: decision.outcome,
      predictedProbability: market.prices?.[decision.outcome] ?? 0.5,
      confidenceLevel: decision.confidence,
      reasoning: decision.reasoning,
    });

    try {
      // Map outcome to Manifold format
      const outcome = decision.outcome === 'YES' || decision.outcome === 'NO'
        ? decision.outcome
        : market.manifold?.answers?.find(a => a.text === decision.outcome)?.id ?? decision.outcome;

      // Place bet
      const bet = await this.client.placeBet({
        contractId: market.id,
        amount: Math.round(decision.amount), // Mana is integer
        outcome,
      });

      // Record execution
      recordExecution({
        id: predictionId,
        executionPrice: bet.probAfter,
        positionSize: bet.amount,
        cashDelta: -bet.amount,
      });

      recordTrade({
        predictionId,
        marketId: market.id,
        marketTitle: market.question,
        outcome: decision.outcome,
        side: decision.action,
        price: bet.probAfter,
        amount: bet.amount,
        shares: bet.shares,
      });

      return {
        executed: true,
        message: `Bet placed: ${bet.amount} mana on ${decision.outcome} @ ${(bet.probAfter * 100).toFixed(1)}%`,
      };
    } catch (error) {
      return {
        executed: false,
        message: `Bet failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async getBalance(): Promise<number> {
    const user = await this.client.getMe();
    return user.balance;
  }

  async getPositions(): Promise<Array<{
    marketId: string;
    outcome: string;
    shares: number;
    value: number;
  }>> {
    const bets = await this.client.getMyBets({ limit: 1000 });

    // Aggregate by market and outcome
    const positions = new Map<string, { shares: number; outcome: string }>();

    for (const bet of bets) {
      if (bet.isCancelled) continue;

      const key = `${bet.contractId}-${bet.outcome}`;
      const existing = positions.get(key) ?? { shares: 0, outcome: bet.outcome };
      existing.shares += bet.shares;
      positions.set(key, existing);
    }

    // Filter to non-zero positions
    return Array.from(positions.entries())
      .filter(([, pos]) => Math.abs(pos.shares) > 0.01)
      .map(([key, pos]) => ({
        marketId: key.split('-')[0],
        outcome: pos.outcome,
        shares: pos.shares,
        value: pos.shares, // Approximate; real value depends on current price
      }));
  }
}
```

### 4. Calibration Tracker (`src/memory/manifold-calibration.ts`)

```typescript
import { db } from './db.js';

interface CalibrationBucket {
  predictedProbMin: number;
  predictedProbMax: number;
  totalPredictions: number;
  correctPredictions: number;
  actualRate: number;
}

/**
 * Track Manifold predictions for calibration analysis.
 */
export function recordManifoldPrediction(data: {
  marketId: string;
  predictedOutcome: string;
  predictedProb: number;
  actualOutcome?: string;
  resolved: boolean;
}): void {
  db.prepare(`
    INSERT INTO manifold_calibration (
      market_id, predicted_outcome, predicted_prob, actual_outcome, resolved, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    data.marketId,
    data.predictedOutcome,
    data.predictedProb,
    data.actualOutcome ?? null,
    data.resolved ? 1 : 0,
    Date.now()
  );
}

/**
 * Update prediction when market resolves.
 */
export function resolveManifoldPrediction(
  marketId: string,
  actualOutcome: string
): void {
  db.prepare(`
    UPDATE manifold_calibration
    SET actual_outcome = ?, resolved = 1
    WHERE market_id = ?
  `).run(actualOutcome, marketId);
}

/**
 * Calculate calibration curve.
 */
export function getCalibrationCurve(): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  const bucketSize = 0.1;

  for (let min = 0; min < 1; min += bucketSize) {
    const max = min + bucketSize;

    const result = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN predicted_outcome = actual_outcome THEN 1 ELSE 0 END) as correct
      FROM manifold_calibration
      WHERE resolved = 1
        AND predicted_prob >= ? AND predicted_prob < ?
    `).get(min, max) as { total: number; correct: number };

    buckets.push({
      predictedProbMin: min,
      predictedProbMax: max,
      totalPredictions: result.total,
      correctPredictions: result.correct,
      actualRate: result.total > 0 ? result.correct / result.total : 0,
    });
  }

  return buckets;
}

/**
 * Calculate Brier score for Manifold predictions.
 */
export function getManifoldBrierScore(): number {
  const result = db.prepare(`
    SELECT AVG(
      POWER(predicted_prob - CASE WHEN predicted_outcome = actual_outcome THEN 1.0 ELSE 0.0 END, 2)
    ) as brier
    FROM manifold_calibration
    WHERE resolved = 1
  `).get() as { brier: number };

  return result.brier ?? 0;
}

/**
 * Get calibration summary.
 */
export function getManifoldCalibrationSummary(): {
  totalPredictions: number;
  resolvedPredictions: number;
  brierScore: number;
  calibrationCurve: CalibrationBucket[];
  overconfidenceRatio: number;
} {
  const total = db.prepare(`SELECT COUNT(*) as n FROM manifold_calibration`).get() as { n: number };
  const resolved = db.prepare(`SELECT COUNT(*) as n FROM manifold_calibration WHERE resolved = 1`).get() as { n: number };

  const curve = getCalibrationCurve();
  const brier = getManifoldBrierScore();

  // Calculate overconfidence: how often high-confidence predictions are wrong
  const highConf = curve.filter(b => b.predictedProbMin >= 0.7);
  const overconfidence = highConf.length > 0
    ? highConf.reduce((sum, b) => sum + (b.predictedProbMax - 0.05 - b.actualRate) * b.totalPredictions, 0) /
      highConf.reduce((sum, b) => sum + b.totalPredictions, 0)
    : 0;

  return {
    totalPredictions: total.n,
    resolvedPredictions: resolved.n,
    brierScore: brier,
    calibrationCurve: curve,
    overconfidenceRatio: Math.max(0, overconfidence),
  };
}
```

## Config Schema

```yaml
manifold:
  enabled: true
  apiKey: '${MANIFOLD_API_KEY}'

  # Market filters
  filters:
    minVolume: 100           # Minimum mana traded
    minBettors: 5            # Minimum unique bettors
    maxCloseTime: 30         # Days until close (skip long-term)
    excludeCreators: []      # Usernames to exclude

  # Betting limits (in mana)
  limits:
    perBet: 100              # Max mana per bet
    daily: 1000              # Max mana per day
    maxOpenPositions: 20     # Max concurrent positions

  # Calibration
  calibration:
    trackAll: true           # Track all predictions for calibration
    minConfidence: 0.6       # Only bet when confidence > threshold
```

## CLI Commands

```bash
# Search markets
thufir manifold search "bitcoin"
thufir manifold search "politics" --sort=liquidity --limit=20

# Get market details
thufir manifold market "will-bitcoin-reach-100k-in-2026"

# Place bet
thufir manifold bet <market-id> YES 50  # Bet 50 mana on YES

# View portfolio
thufir manifold portfolio

# View calibration
thufir manifold calibration
```

## WebSocket (Real-time Updates)

```typescript
// Optional: Subscribe to real-time market updates
const ws = new WebSocket('wss://api.manifold.markets/ws');

ws.onopen = () => {
  // Subscribe to specific market
  ws.send(JSON.stringify({
    type: 'subscribe',
    topic: 'contract/CONTRACT_ID/bets',
  }));

  // Keep alive
  setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), 30000);
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'bet') {
    console.log('New bet:', data);
  }
};
```

## Integration with Thufir's Intel Layer

The key advantage: Manifold has **general event markets** that match Thufir's intel-driven approach.

```typescript
// Example: Cross-reference news with Manifold markets
async function findRelevantMarkets(newsEvent: NewsItem): Promise<ManifoldMarket[]> {
  // Extract keywords/entities from news
  const keywords = extractKeywords(newsEvent);

  // Search Manifold for related markets
  const markets = await manifoldClient.searchMarkets({
    term: keywords.join(' '),
    sort: 'liquidity',
    contractType: 'BINARY',
    limit: 10,
  });

  // Filter to markets where news is relevant
  return markets.filter(m =>
    !m.isResolved &&
    m.closeTime && m.closeTime > Date.now() &&
    m.volume > 100
  );
}

// Example: Use existing opportunity scanner with Manifold
async function scanManifoldOpportunities(): Promise<Opportunity[]> {
  // Get recent intel
  const intel = await getRecentIntel({ hours: 24 });

  // Get active Manifold markets
  const markets = await manifoldClient.listMarkets({
    limit: 100,
    sort: 'liquidity',
  });

  // Cross-reference (reuse existing opportunity logic)
  return findOpportunities(intel, markets.map(normalizeManifoldMarket));
}
```

## Calibration Workflow

1. **Phase 1: Shadow Mode** (Week 1-2)
   - Run Thufir's decision loop on Manifold markets
   - Record predictions WITHOUT betting
   - Accumulate baseline calibration data

2. **Phase 2: Small Bets** (Week 3-4)
   - Enable small bets (10-50 mana)
   - Continue tracking calibration
   - Tune confidence thresholds

3. **Phase 3: Full Deployment** (Week 5+)
   - Increase bet sizes based on calibration
   - Apply learnings to real money markets
   - Maintain parallel Manifold tracking

## Migration Checklist

- [ ] Create `src/execution/manifold/` directory
- [ ] Implement `ManifoldClient` with full API coverage
- [ ] Create `ManifoldExecutor` implementing `ExecutionAdapter`
- [ ] Add market normalization
- [ ] Add calibration tracking tables
- [ ] Add CLI commands
- [ ] Add config schema
- [ ] Connect to opportunity scanner
- [ ] Add to autonomous manager
- [ ] Test with real Manifold account

## References

- [Manifold API Docs](https://docs.manifold.markets/api)
- [Manifold GitHub](https://github.com/manifoldmarkets/manifold)
- [manifoldpy (Python SDK)](https://github.com/vluzko/manifoldpy)
