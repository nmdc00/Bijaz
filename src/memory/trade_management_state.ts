import { openDatabase } from './db.js';

export type TradeManagementPositionState = {
  symbol: string;
  side: 'long' | 'short';
  enteredAt: string; // ISO
  expiresAt: string; // ISO
  entryPrice: number | null;
  stopLossPct: number;
  takeProfitPct: number;
  slCloid: string;
  tpCloid: string;
};

function ensureTable(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_management_state (
      symbol TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export function upsertTradeManagementState(state: TradeManagementPositionState): void {
  ensureTable();
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO trade_management_state (symbol, payload, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(symbol) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `
  ).run(state.symbol, JSON.stringify(state));
}

export function getTradeManagementState(symbol: string): TradeManagementPositionState | null {
  ensureTable();
  const db = openDatabase();
  const row = db
    .prepare(`SELECT payload FROM trade_management_state WHERE symbol = ?`)
    .get(symbol) as { payload?: string } | undefined;
  if (!row?.payload) return null;
  try {
    return JSON.parse(row.payload) as TradeManagementPositionState;
  } catch {
    return null;
  }
}

export function deleteTradeManagementState(symbol: string): void {
  ensureTable();
  const db = openDatabase();
  db.prepare(`DELETE FROM trade_management_state WHERE symbol = ?`).run(symbol);
}

