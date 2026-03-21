import { openDatabase } from './db.js';

function ensureSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_exit_consult_log (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      symbol                 TEXT NOT NULL,
      side                   TEXT NOT NULL,
      roe_at_consult         REAL NOT NULL,
      time_held_ms           INTEGER NOT NULL,
      action                 TEXT NOT NULL,
      reasoning              TEXT NOT NULL,
      new_time_stop_at_ms    INTEGER,
      new_invalidation_price REAL,
      reduce_to_fraction     REAL,
      used_fallback          INTEGER NOT NULL DEFAULT 0
    )
  `);
}

export type ExitConsultLogEntry = {
  symbol: string;
  side: string;
  roeAtConsult: number;
  timeHeldMs: number;
  action: string;
  reasoning: string;
  newTimeStopAtMs: number | null;
  newInvalidationPrice: number | null;
  reduceToFraction: number | null;
  usedFallback: 0 | 1;
};

export function recordExitConsultDecision(entry: ExitConsultLogEntry): void {
  ensureSchema();
  const db = openDatabase();
  db.prepare(
    `INSERT INTO llm_exit_consult_log
       (symbol, side, roe_at_consult, time_held_ms, action, reasoning,
        new_time_stop_at_ms, new_invalidation_price, reduce_to_fraction, used_fallback)
     VALUES
       (@symbol, @side, @roeAtConsult, @timeHeldMs, @action, @reasoning,
        @newTimeStopAtMs, @newInvalidationPrice, @reduceToFraction, @usedFallback)`
  ).run({
    symbol: entry.symbol,
    side: entry.side,
    roeAtConsult: entry.roeAtConsult,
    timeHeldMs: entry.timeHeldMs,
    action: entry.action,
    reasoning: entry.reasoning,
    newTimeStopAtMs: entry.newTimeStopAtMs ?? null,
    newInvalidationPrice: entry.newInvalidationPrice ?? null,
    reduceToFraction: entry.reduceToFraction ?? null,
    usedFallback: entry.usedFallback,
  });
}
