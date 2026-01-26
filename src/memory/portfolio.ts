import { openDatabase } from './db.js';

export interface PortfolioState {
  cashBalance: number;
  updatedAt?: string;
}

function normalizeAmount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value;
}

export function getCashBalance(): number {
  const db = openDatabase();
  const row = db
    .prepare(
      `
        SELECT cash_balance as cashBalance, updated_at as updatedAt
        FROM portfolio_state
        WHERE id = 1
      `
    )
    .get() as PortfolioState | undefined;

  return Number(row?.cashBalance ?? 0);
}

export function setCashBalance(amount: number): number {
  const db = openDatabase();
  const normalized = normalizeAmount(amount);
  db.prepare(
    `
      INSERT INTO portfolio_state (id, cash_balance, updated_at)
      VALUES (1, @cashBalance, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        cash_balance = excluded.cash_balance,
        updated_at = datetime('now')
    `
  ).run({ cashBalance: normalized });
  return normalized;
}

export function adjustCashBalance(delta: number): number {
  const normalized = normalizeAmount(delta);
  if (normalized === 0) {
    return getCashBalance();
  }
  const current = getCashBalance();
  const updated = current + normalized;
  setCashBalance(updated);
  return updated;
}
