import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

const previousDbPath = process.env.THUFIR_DB_PATH;

function createLegacyDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-entry-gate-log-'));
  const dbPath = join(dir, 'thufir.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE llm_entry_gate_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      notional_usd REAL NOT NULL,
      verdict TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      adjusted_size_usd REAL,
      used_fallback INTEGER NOT NULL DEFAULT 0,
      signal_class TEXT,
      regime TEXT,
      session TEXT,
      edge REAL
    )
  `);
  db.close();
  return dbPath;
}

afterEach(() => {
  vi.resetModules();
  const dbPath = process.env.THUFIR_DB_PATH;
  if (dbPath) {
    rmSync(dbPath, { force: true });
    rmSync(dirname(dbPath), { recursive: true, force: true });
  }
  if (previousDbPath === undefined) {
    delete process.env.THUFIR_DB_PATH;
  } else {
    process.env.THUFIR_DB_PATH = previousDbPath;
  }
});

describe('recordEntryGateDecision schema migration', () => {
  it('adds missing risk columns to a legacy llm_entry_gate_log table before insert', async () => {
    const dbPath = createLegacyDb();
    process.env.THUFIR_DB_PATH = dbPath;

    const { recordEntryGateDecision } = await import('../../src/memory/llm_entry_gate_log.js');
    recordEntryGateDecision({
      symbol: 'BTC',
      side: 'long',
      notionalUsd: 100,
      verdict: 'approve',
      reasoning: 'ok',
      reasonCode: 'approve',
      usedFallback: false,
      stopLevelPrice: 95,
      equityAtRiskPct: 0.5,
      targetRR: 2,
    });

    const db = new Database(dbPath, { readonly: true });
    const columns = db.prepare("PRAGMA table_info('llm_entry_gate_log')").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    expect(columnNames.has('stop_level_price')).toBe(true);
    expect(columnNames.has('equity_at_risk_pct')).toBe(true);
    expect(columnNames.has('target_rr')).toBe(true);

    const row = db
      .prepare(
        'SELECT stop_level_price, equity_at_risk_pct, target_rr FROM llm_entry_gate_log ORDER BY id DESC LIMIT 1'
      )
      .get() as { stop_level_price: number; equity_at_risk_pct: number; target_rr: number };
    expect(row).toEqual({
      stop_level_price: 95,
      equity_at_risk_pct: 0.5,
      target_rr: 2,
    });
    db.close();
  });

  it('adds missing reason_code column to a legacy llm_entry_gate_log table before insert', async () => {
    const dbPath = createLegacyDb();
    process.env.THUFIR_DB_PATH = dbPath;

    const { recordEntryGateDecision } = await import('../../src/memory/llm_entry_gate_log.js');
    recordEntryGateDecision({
      symbol: 'ETH',
      side: 'short',
      notionalUsd: 80,
      verdict: 'reject',
      reasoning: 'Opposite-side position already open on this symbol. Cannot open conflicting trade.',
      reasonCode: 'book_conflict',
      usedFallback: false,
    });

    const db = new Database(dbPath, { readonly: true });
    const columns = db.prepare("PRAGMA table_info('llm_entry_gate_log')").all() as Array<{ name: string }>;
    expect(new Set(columns.map((column) => column.name)).has('reason_code')).toBe(true);
    const row = db
      .prepare('SELECT reason_code FROM llm_entry_gate_log ORDER BY id DESC LIMIT 1')
      .get() as { reason_code: string };
    expect(row.reason_code).toBe('book_conflict');
    db.close();
  });
});
