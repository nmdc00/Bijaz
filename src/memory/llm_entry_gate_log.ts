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
  stopLevelPrice?: number | null;
  equityAtRiskPct?: number;
  targetRR?: number;
  suggestedLeverage?: number;
}

function ensureSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_entry_gate_log (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      symbol              TEXT NOT NULL,
      side                TEXT NOT NULL,
      notional_usd        REAL NOT NULL,
      verdict             TEXT NOT NULL,
      reasoning           TEXT NOT NULL,
      adjusted_size_usd   REAL,
      used_fallback       INTEGER NOT NULL DEFAULT 0,
      signal_class        TEXT,
      regime              TEXT,
      session             TEXT,
      edge                REAL,
      stop_level_price    REAL,
      equity_at_risk_pct  REAL,
      target_rr           REAL
    )
  `);

  const columns = db.prepare("PRAGMA table_info('llm_entry_gate_log')").all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  const addColumnIfMissing = (name: string, definition: string): void => {
    if (columnNames.has(name)) {
      return;
    }
    db.exec(`ALTER TABLE llm_entry_gate_log ADD COLUMN ${definition}`);
    columnNames.add(name);
  };

  addColumnIfMissing('stop_level_price', 'stop_level_price REAL');
  addColumnIfMissing('equity_at_risk_pct', 'equity_at_risk_pct REAL');
  addColumnIfMissing('target_rr', 'target_rr REAL');
  addColumnIfMissing('suggested_leverage', 'suggested_leverage REAL');
}

export function recordEntryGateDecision(entry: EntryGateLogEntry): void {
  ensureSchema();
  const db = openDatabase();
  db.prepare(
    `INSERT INTO llm_entry_gate_log
       (symbol, side, notional_usd, verdict, reasoning, adjusted_size_usd, used_fallback, signal_class, regime, session, edge, stop_level_price, equity_at_risk_pct, target_rr, suggested_leverage)
     VALUES
       (@symbol, @side, @notionalUsd, @verdict, @reasoning, @adjustedSizeUsd, @usedFallback, @signalClass, @regime, @session, @edge, @stopLevelPrice, @equityAtRiskPct, @targetRR, @suggestedLeverage)`
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
    stopLevelPrice: entry.stopLevelPrice ?? null,
    equityAtRiskPct: entry.equityAtRiskPct ?? null,
    targetRR: entry.targetRR ?? null,
    suggestedLeverage: entry.suggestedLeverage ?? null,
  });
}
