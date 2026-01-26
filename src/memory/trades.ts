import { openDatabase } from './db.js';

export interface TradeInput {
  predictionId?: string | null;
  marketId: string;
  marketTitle: string;
  outcome: 'YES' | 'NO';
  side: 'buy' | 'sell';
  price?: number | null;
  amount?: number | null;
  shares?: number | null;
}

export interface TradeRecord {
  id: number;
  predictionId?: string | null;
  marketId: string;
  marketTitle: string;
  outcome: 'YES' | 'NO';
  side: 'buy' | 'sell';
  price?: number | null;
  amount?: number | null;
  shares?: number | null;
  createdAt: string;
}

export interface OpenTradePosition {
  marketId: string;
  marketTitle: string;
  predictedOutcome: 'YES' | 'NO';
  executionPrice: number;
  positionSize: number;
  netShares: number;
  realizedPnl?: number | null;
  createdAt: string;
  currentPrices?: Record<string, number> | number[] | null;
}

function parseJsonObject(value: string | null): Record<string, number> | number[] | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed as number[];
    }
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, number>;
    }
  } catch {
    return null;
  }
  return null;
}

export function recordTrade(input: TradeInput): void {
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO trades (
        prediction_id,
        market_id,
        market_title,
        outcome,
        side,
        price,
        amount,
        shares
      ) VALUES (
        @predictionId,
        @marketId,
        @marketTitle,
        @outcome,
        @side,
        @price,
        @amount,
        @shares
      )
    `
  ).run({
    predictionId: input.predictionId ?? null,
    marketId: input.marketId,
    marketTitle: input.marketTitle,
    outcome: input.outcome,
    side: input.side,
    price: input.price ?? null,
    amount: input.amount ?? null,
    shares: input.shares ?? null,
  });
}

export function listTradesByPrediction(predictionId: string): TradeRecord[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          prediction_id as predictionId,
          market_id as marketId,
          market_title as marketTitle,
          outcome,
          side,
          price,
          amount,
          shares,
          created_at as createdAt
        FROM trades
        WHERE prediction_id = ?
        ORDER BY created_at ASC
      `
    )
    .all(predictionId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    predictionId: (row.predictionId as string | null) ?? null,
    marketId: String(row.marketId),
    marketTitle: String(row.marketTitle),
    outcome: String(row.outcome) as 'YES' | 'NO',
    side: String(row.side) as 'buy' | 'sell',
    price: row.price as number | null,
    amount: row.amount as number | null,
    shares: row.shares as number | null,
    createdAt: String(row.createdAt),
  }));
}

export function listTradesByMarketOutcome(
  marketId: string,
  outcome: 'YES' | 'NO'
): TradeRecord[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          prediction_id as predictionId,
          market_id as marketId,
          market_title as marketTitle,
          outcome,
          side,
          price,
          amount,
          shares,
          created_at as createdAt
        FROM trades
        WHERE market_id = ? AND outcome = ?
        ORDER BY created_at ASC
      `
    )
    .all(marketId, outcome) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    predictionId: (row.predictionId as string | null) ?? null,
    marketId: String(row.marketId),
    marketTitle: String(row.marketTitle),
    outcome: String(row.outcome) as 'YES' | 'NO',
    side: String(row.side) as 'buy' | 'sell',
    price: row.price as number | null,
    amount: row.amount as number | null,
    shares: row.shares as number | null,
    createdAt: String(row.createdAt),
  }));
}

export function computeRealizedPnl(trades: TradeRecord[]): number {
  let realized = 0;
  const lots: Array<{ shares: number; costPerShare: number }> = [];

  for (const trade of trades) {
    const shares =
      trade.shares ??
      (trade.price && trade.amount ? trade.amount / trade.price : null);
    const amount = trade.amount ?? null;
    if (!shares || !amount || shares <= 0) {
      continue;
    }

    const costPerShare = trade.price ? trade.price : amount / shares;

    if (trade.side === 'buy') {
      lots.push({ shares, costPerShare });
      continue;
    }

    let remaining = shares;
    let costBasis = 0;
    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0]!;
      const used = Math.min(remaining, lot.shares);
      costBasis += used * lot.costPerShare;
      lot.shares -= used;
      remaining -= used;
      if (lot.shares <= 0) {
        lots.shift();
      }
    }

    const proceeds = amount;
    realized += proceeds - costBasis;
  }

  return realized;
}

export function listOpenPositionsFromTrades(limit = 50): OpenTradePosition[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          market_id as marketId,
          MAX(market_title) as marketTitle,
          outcome,
          SUM(CASE WHEN side = 'buy' THEN shares ELSE -shares END) as netShares,
          SUM(CASE WHEN side = 'buy' THEN amount ELSE 0 END) as totalBuy,
          SUM(CASE WHEN side = 'buy' THEN shares ELSE 0 END) as totalBuyShares,
          SUM(CASE WHEN side = 'sell' THEN amount ELSE 0 END) as totalSell,
          MAX(created_at) as lastTradeAt,
          m.prices as currentPrices
        FROM trades t
        LEFT JOIN market_cache m ON t.market_id = m.id
        GROUP BY market_id, outcome
        HAVING ABS(SUM(CASE WHEN side = 'buy' THEN shares ELSE -shares END)) > 1e-9
        ORDER BY lastTradeAt DESC
        LIMIT ?
      `
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const totalBuy = Number(row.totalBuy ?? 0);
    const totalBuyShares = Number(row.totalBuyShares ?? 0);
    const totalSell = Number(row.totalSell ?? 0);
    const executionPrice = totalBuyShares > 0 ? totalBuy / totalBuyShares : 0;
    const netShares = Number(row.netShares ?? 0);
    const positionSize = totalBuy - totalSell;
    const outcome = String(row.outcome ?? 'YES') as 'YES' | 'NO';
    const marketId = String(row.marketId);
    const trades = listTradesByMarketOutcome(marketId, outcome);
    const realizedPnl = trades.length > 0 ? computeRealizedPnl(trades) : null;

    return {
      marketId,
      marketTitle: String(row.marketTitle ?? ''),
      predictedOutcome: outcome,
      executionPrice,
      positionSize,
      netShares,
      realizedPnl,
      createdAt: String(row.lastTradeAt),
      currentPrices: parseJsonObject((row.currentPrices as string | null) ?? null),
    };
  });
}
