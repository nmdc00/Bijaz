import { openDatabase } from './db.js';

export interface EntryGateLogEntry {
  symbol: string;
  side: string;
  notionalUsd: number;
  verdict: string;
  reasoning: string;
  adjustedSizeUsd?: number;
  usedFallback: boolean;
  signalClass?: string;
  regime?: string;
  session?: string;
  edge?: number;
}

function ensureSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_entry_gate_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      symbol            TEXT NOT NULL,
      side              TEXT NOT NULL,
      notional_usd      REAL NOT NULL,
      verdict           TEXT NOT NULL,
      reasoning         TEXT NOT NULL,
      adjusted_size_usd REAL,
      used_fallback     INTEGER NOT NULL DEFAULT 0,
      signal_class      TEXT,
      regime            TEXT,
      session           TEXT,
      edge              REAL
    )
  `);
}

export function recordEntryGateDecision(entry: EntryGateLogEntry): void {
  ensureSchema();
  const db = openDatabase();
  db.prepare(
    `INSERT INTO llm_entry_gate_log
       (symbol, side, notional_usd, verdict, reasoning, adjusted_size_usd, used_fallback, signal_class, regime, session, edge)
     VALUES
       (@symbol, @side, @notionalUsd, @verdict, @reasoning, @adjustedSizeUsd, @usedFallback, @signalClass, @regime, @session, @edge)`
  ).run({
    symbol: entry.symbol,
    side: entry.side,
    notionalUsd: entry.notionalUsd,
    verdict: entry.verdict,
    reasoning: entry.reasoning,
    adjustedSizeUsd: entry.adjustedSizeUsd ?? null,
    usedFallback: entry.usedFallback ? 1 : 0,
    signalClass: entry.signalClass ?? null,
    regime: entry.regime ?? null,
    session: entry.session ?? null,
    edge: entry.edge ?? null,
  });
}
