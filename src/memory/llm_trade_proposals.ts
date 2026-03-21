import { openDatabase } from './db.js';

export interface TradeProposalRecord {
  triggerReason: 'cadence' | 'ta_alert' | 'event';
  alertedSymbols?: string[];
  proposed: boolean;
  symbol?: string;
  side?: string;
  thesisText?: string;
  invalidationCondition?: string;
  invalidationPrice?: number | null;
  suggestedTtlMinutes?: number;
  confidence?: number;
  entryGateVerdict?: string;
  executed?: boolean;
  tradeId?: string;
  usedFallback?: boolean;
}

function ensureSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_trade_proposals (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      trigger_reason         TEXT NOT NULL,
      alerted_symbols        TEXT,
      proposed               INTEGER NOT NULL,
      symbol                 TEXT,
      side                   TEXT,
      thesis_text            TEXT,
      invalidation_condition TEXT,
      invalidation_price     REAL,
      suggested_ttl_minutes  INTEGER,
      confidence             REAL,
      entry_gate_verdict     TEXT,
      executed               INTEGER NOT NULL DEFAULT 0,
      trade_id               TEXT,
      used_fallback          INTEGER NOT NULL DEFAULT 0
    )
  `);
}

export function recordTradeProposal(record: TradeProposalRecord): number {
  ensureSchema();
  const db = openDatabase();
  const result = db.prepare(
    `INSERT INTO llm_trade_proposals
       (trigger_reason, alerted_symbols, proposed, symbol, side, thesis_text,
        invalidation_condition, invalidation_price, suggested_ttl_minutes, confidence,
        entry_gate_verdict, executed, trade_id, used_fallback)
     VALUES
       (@triggerReason, @alertedSymbols, @proposed, @symbol, @side, @thesisText,
        @invalidationCondition, @invalidationPrice, @suggestedTtlMinutes, @confidence,
        @entryGateVerdict, @executed, @tradeId, @usedFallback)`
  ).run({
    triggerReason: record.triggerReason,
    alertedSymbols: record.alertedSymbols ? JSON.stringify(record.alertedSymbols) : null,
    proposed: record.proposed ? 1 : 0,
    symbol: record.symbol ?? null,
    side: record.side ?? null,
    thesisText: record.thesisText ?? null,
    invalidationCondition: record.invalidationCondition ?? null,
    invalidationPrice: record.invalidationPrice ?? null,
    suggestedTtlMinutes: record.suggestedTtlMinutes ?? null,
    confidence: record.confidence ?? null,
    entryGateVerdict: record.entryGateVerdict ?? null,
    executed: record.executed ? 1 : 0,
    tradeId: record.tradeId ?? null,
    usedFallback: record.usedFallback ? 1 : 0,
  });
  return Number(result.lastInsertRowid);
}

export function updateTradeProposalOutcome(
  id: number,
  verdict: string,
  executed: boolean,
  tradeId?: string
): void {
  ensureSchema();
  const db = openDatabase();
  db.prepare(
    `UPDATE llm_trade_proposals
     SET entry_gate_verdict = @verdict, executed = @executed, trade_id = @tradeId
     WHERE id = @id`
  ).run({
    id,
    verdict,
    executed: executed ? 1 : 0,
    tradeId: tradeId ?? null,
  });
}
