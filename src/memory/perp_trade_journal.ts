import { openDatabase } from './db.js';
import { storeDecisionArtifact } from './decision_artifacts.js';

export type PerpTradeJournalOutcome = 'executed' | 'failed' | 'blocked';

export type PerpTradeJournalEntry = {
  kind: 'perp_trade_journal';
  tradeId?: number | null;
  hypothesisId?: string | null;
  symbol: string;
  side?: 'buy' | 'sell' | null;
  size?: number | null;
  leverage?: number | null;
  orderType?: 'market' | 'limit' | null;
  reduceOnly?: boolean | null;
  markPrice?: number | null;
  confidence?: string | null;
  reasoning?: string | null;
  outcome: PerpTradeJournalOutcome;
  message?: string | null;
  error?: string | null;
  snapshot?: Record<string, unknown> | null;
};

export function recordPerpTradeJournal(entry: PerpTradeJournalEntry): void {
  const fingerprint = entry.tradeId ? `${entry.symbol}:${entry.tradeId}` : null;
  storeDecisionArtifact({
    source: 'perps',
    kind: entry.kind,
    marketId: entry.symbol,
    fingerprint,
    outcome: entry.outcome,
    payload: entry,
  });
}

export function listPerpTradeJournals(params?: {
  symbol?: string;
  limit?: number;
}): PerpTradeJournalEntry[] {
  const db = openDatabase();
  const limit = Math.min(Math.max(params?.limit ?? 50, 1), 500);
  const symbol = params?.symbol ?? null;
  const rows = db
    .prepare(
      `
        SELECT payload
        FROM decision_artifacts
        WHERE kind = 'perp_trade_journal'
          AND (? IS NULL OR market_id = ?)
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(symbol, symbol, limit) as Array<{ payload?: string }>;

  const out: PerpTradeJournalEntry[] = [];
  for (const row of rows) {
    if (!row?.payload) continue;
    try {
      const parsed = JSON.parse(row.payload) as PerpTradeJournalEntry;
      if (parsed && parsed.kind === 'perp_trade_journal') {
        out.push(parsed);
      }
    } catch {
      // ignore unparseable payloads
    }
  }
  return out;
}

