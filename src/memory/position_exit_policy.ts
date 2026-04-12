import { openDatabase } from './db.js';

export type PositionExitPolicy = {
  symbol: string;
  side: 'long' | 'short';
  timeStopAtMs: number | null;
  invalidationPrice: number | null;
  notes: string | null;
  entryAtMs: number | null;
};

function ensureSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS position_exit_policy (
      symbol TEXT PRIMARY KEY,
      side TEXT NOT NULL,
      time_stop_at_ms INTEGER,
      invalidation_price REAL,
      notes TEXT,
      entry_at_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // Migration: add entry_at_ms to existing tables that predate this column.
  try {
    db.exec(`ALTER TABLE position_exit_policy ADD COLUMN entry_at_ms INTEGER`);
  } catch {
    // Column already exists — safe to ignore.
  }
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function upsertPositionExitPolicy(
  symbol: string,
  side: 'long' | 'short',
  timeStopAtMs: number | null,
  invalidationPrice: number | null,
  notes?: string | null
): void {
  ensureSchema();
  const db = openDatabase();
  db.prepare(
    `INSERT INTO position_exit_policy (symbol, side, time_stop_at_ms, invalidation_price, notes, entry_at_ms, created_at)
     VALUES (@symbol, @side, @timeStopAtMs, @invalidationPrice, @notes, @entryAtMs, datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET
       side = excluded.side,
       time_stop_at_ms = excluded.time_stop_at_ms,
       invalidation_price = excluded.invalidation_price,
       notes = excluded.notes`
    // entry_at_ms intentionally excluded from UPDATE — preserves original entry time across
    // heartbeat mutations like extend_ttl / update_invalidation.
  ).run({
    symbol: normalizeSymbol(symbol),
    side,
    timeStopAtMs: timeStopAtMs ?? null,
    invalidationPrice: invalidationPrice ?? null,
    notes: notes ?? null,
    entryAtMs: Date.now(),
  });
}

export function getPositionExitPolicy(symbol: string): PositionExitPolicy | null {
  ensureSchema();
  const db = openDatabase();
  const row = db
    .prepare(
      `SELECT symbol, side, time_stop_at_ms, invalidation_price, notes, entry_at_ms
       FROM position_exit_policy WHERE symbol = @symbol LIMIT 1`
    )
    .get({ symbol: normalizeSymbol(symbol) }) as Record<string, unknown> | undefined;

  if (!row) return null;
  return {
    symbol: String(row.symbol ?? ''),
    side: String(row.side ?? 'long') === 'short' ? 'short' : 'long',
    timeStopAtMs: row.time_stop_at_ms != null ? Number(row.time_stop_at_ms) : null,
    invalidationPrice: row.invalidation_price != null ? Number(row.invalidation_price) : null,
    notes: row.notes != null ? String(row.notes) : null,
    entryAtMs: row.entry_at_ms != null ? Number(row.entry_at_ms) : null,
  };
}

export function clearPositionExitPolicy(symbol: string): void {
  ensureSchema();
  const db = openDatabase();
  db.prepare(`DELETE FROM position_exit_policy WHERE symbol = @symbol`).run({
    symbol: normalizeSymbol(symbol),
  });
}
