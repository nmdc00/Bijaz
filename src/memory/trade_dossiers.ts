import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export type TradeDossierStatus = 'open' | 'closed';

export interface TradeDossier {
  id: string;
  symbol: string;
  status: TradeDossierStatus;
  direction: 'long' | 'short' | null;
  strategySource: string | null;
  executionMode: 'paper' | 'live' | null;
  sourceTradeId: number | null;
  sourcePredictionId: string | null;
  proposalRecordId: number | null;
  triggerReason: string | null;
  openedAt: string | null;
  closedAt: string | null;
  dossier: Record<string, unknown> | null;
  review: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface UpsertTradeDossierInput {
  id?: string;
  symbol: string;
  status: TradeDossierStatus;
  direction?: 'long' | 'short' | null;
  strategySource?: string | null;
  executionMode?: 'paper' | 'live' | null;
  sourceTradeId?: number | null;
  sourcePredictionId?: string | null;
  proposalRecordId?: number | null;
  triggerReason?: string | null;
  openedAt?: string | null;
  closedAt?: string | null;
  dossier?: Record<string, unknown> | null;
  review?: Record<string, unknown> | null;
}

function serializeJson(value: Record<string, unknown> | null | undefined): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  return value;
}

function ensureTradeDossierSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_dossiers (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open', 'closed')),
      direction TEXT CHECK(direction IN ('long', 'short')),
      strategy_source TEXT,
      execution_mode TEXT CHECK(execution_mode IN ('paper', 'live')),
      source_trade_id INTEGER,
      source_prediction_id TEXT,
      proposal_record_id INTEGER,
      trigger_reason TEXT,
      opened_at TEXT,
      closed_at TEXT,
      dossier_payload TEXT,
      review_payload TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trade_dossiers_symbol ON trade_dossiers(symbol);
    CREATE INDEX IF NOT EXISTS idx_trade_dossiers_status ON trade_dossiers(status);
    CREATE INDEX IF NOT EXISTS idx_trade_dossiers_trade ON trade_dossiers(source_trade_id);
    CREATE INDEX IF NOT EXISTS idx_trade_dossiers_prediction ON trade_dossiers(source_prediction_id);
  `);
}

function rowToTradeDossier(row: Record<string, unknown> | undefined): TradeDossier | null {
  if (!row) return null;
  return {
    id: String(row.id ?? ''),
    symbol: String(row.symbol ?? ''),
    status: row.status === 'closed' ? 'closed' : 'open',
    direction:
      row.direction === 'long' || row.direction === 'short'
        ? (row.direction as 'long' | 'short')
        : null,
    strategySource: row.strategy_source == null ? null : String(row.strategy_source),
    executionMode:
      row.execution_mode === 'paper' || row.execution_mode === 'live'
        ? (row.execution_mode as 'paper' | 'live')
        : null,
    sourceTradeId: row.source_trade_id == null ? null : Number(row.source_trade_id),
    sourcePredictionId: row.source_prediction_id == null ? null : String(row.source_prediction_id),
    proposalRecordId: row.proposal_record_id == null ? null : Number(row.proposal_record_id),
    triggerReason: row.trigger_reason == null ? null : String(row.trigger_reason),
    openedAt: row.opened_at == null ? null : String(row.opened_at),
    closedAt: row.closed_at == null ? null : String(row.closed_at),
    dossier: parseJson(typeof row.dossier_payload === 'string' ? row.dossier_payload : null),
    review: parseJson(typeof row.review_payload === 'string' ? row.review_payload : null),
    createdAt: String(row.created_at ?? ''),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
  };
}

function deepMerge(
  base: Record<string, unknown> | null,
  incoming: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!base && !incoming) return null;
  if (!base) return incoming ?? null;
  if (!incoming) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    const baseValue = merged[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === 'object' &&
      !Array.isArray(baseValue)
    ) {
      merged[key] = deepMerge(
        baseValue as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function upsertTradeDossier(input: UpsertTradeDossierInput): TradeDossier {
  ensureTradeDossierSchema();
  const db = openDatabase();
  const existing =
    (input.id ? getTradeDossierById(input.id) : null) ??
    (input.sourceTradeId != null ? findTradeDossierByTradeId(input.sourceTradeId) : null) ??
    (input.status === 'open' ? findOpenTradeDossierBySymbol(input.symbol) : null);
  const id = input.id ?? existing?.id ?? randomUUID();
  const mergedDossier = deepMerge(existing?.dossier ?? null, input.dossier);
  const mergedReview = deepMerge(existing?.review ?? null, input.review);

  db.prepare(
    `
      INSERT INTO trade_dossiers (
        id, symbol, status, direction, strategy_source, execution_mode,
        source_trade_id, source_prediction_id, proposal_record_id, trigger_reason,
        opened_at, closed_at, dossier_payload, review_payload, updated_at
      ) VALUES (
        @id, @symbol, @status, @direction, @strategySource, @executionMode,
        @sourceTradeId, @sourcePredictionId, @proposalRecordId, @triggerReason,
        @openedAt, @closedAt, @dossierPayload, @reviewPayload, datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        symbol = excluded.symbol,
        status = excluded.status,
        direction = COALESCE(excluded.direction, trade_dossiers.direction),
        strategy_source = COALESCE(excluded.strategy_source, trade_dossiers.strategy_source),
        execution_mode = COALESCE(excluded.execution_mode, trade_dossiers.execution_mode),
        source_trade_id = COALESCE(excluded.source_trade_id, trade_dossiers.source_trade_id),
        source_prediction_id = COALESCE(excluded.source_prediction_id, trade_dossiers.source_prediction_id),
        proposal_record_id = COALESCE(excluded.proposal_record_id, trade_dossiers.proposal_record_id),
        trigger_reason = COALESCE(excluded.trigger_reason, trade_dossiers.trigger_reason),
        opened_at = COALESCE(excluded.opened_at, trade_dossiers.opened_at),
        closed_at = COALESCE(excluded.closed_at, trade_dossiers.closed_at),
        dossier_payload = COALESCE(excluded.dossier_payload, trade_dossiers.dossier_payload),
        review_payload = COALESCE(excluded.review_payload, trade_dossiers.review_payload),
        updated_at = datetime('now')
    `
  ).run({
    id,
    symbol: input.symbol.trim().toUpperCase(),
    status: input.status,
    direction: input.direction ?? existing?.direction ?? null,
    strategySource: input.strategySource ?? existing?.strategySource ?? null,
    executionMode: input.executionMode ?? existing?.executionMode ?? null,
    sourceTradeId: input.sourceTradeId ?? existing?.sourceTradeId ?? null,
    sourcePredictionId: input.sourcePredictionId ?? existing?.sourcePredictionId ?? null,
    proposalRecordId: input.proposalRecordId ?? existing?.proposalRecordId ?? null,
    triggerReason: input.triggerReason ?? existing?.triggerReason ?? null,
    openedAt: normalizeTimestamp(input.openedAt ?? existing?.openedAt ?? null),
    closedAt: normalizeTimestamp(input.closedAt ?? existing?.closedAt ?? null),
    dossierPayload: serializeJson(mergedDossier),
    reviewPayload: serializeJson(mergedReview),
  });

  return (
    getTradeDossierById(id) ?? {
      id,
      symbol: input.symbol.trim().toUpperCase(),
      status: input.status,
      direction: input.direction ?? existing?.direction ?? null,
      strategySource: input.strategySource ?? existing?.strategySource ?? null,
      executionMode: input.executionMode ?? existing?.executionMode ?? null,
      sourceTradeId: input.sourceTradeId ?? existing?.sourceTradeId ?? null,
      sourcePredictionId: input.sourcePredictionId ?? existing?.sourcePredictionId ?? null,
      proposalRecordId: input.proposalRecordId ?? existing?.proposalRecordId ?? null,
      triggerReason: input.triggerReason ?? existing?.triggerReason ?? null,
      openedAt: normalizeTimestamp(input.openedAt ?? existing?.openedAt ?? null),
      closedAt: normalizeTimestamp(input.closedAt ?? existing?.closedAt ?? null),
      dossier: mergedDossier,
      review: mergedReview,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  );
}

export function getTradeDossierById(id: string): TradeDossier | null {
  ensureTradeDossierSchema();
  const db = openDatabase();
  const row = db.prepare('SELECT * FROM trade_dossiers WHERE id = ? LIMIT 1').get(id) as
    | Record<string, unknown>
    | undefined;
  return rowToTradeDossier(row);
}

export function findTradeDossierByTradeId(sourceTradeId: number): TradeDossier | null {
  ensureTradeDossierSchema();
  const db = openDatabase();
  const row = db
    .prepare(
      `SELECT * FROM trade_dossiers WHERE source_trade_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(sourceTradeId) as Record<string, unknown> | undefined;
  return rowToTradeDossier(row);
}

export function findOpenTradeDossierBySymbol(symbol: string): TradeDossier | null {
  ensureTradeDossierSchema();
  const db = openDatabase();
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return null;
  const row = db
    .prepare(
      `SELECT * FROM trade_dossiers WHERE symbol = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`
    )
    .get(normalized) as Record<string, unknown> | undefined;
  return rowToTradeDossier(row);
}

export function listTradeDossiers(params: {
  symbol?: string;
  status?: TradeDossierStatus;
  limit?: number;
} = {}): TradeDossier[] {
  ensureTradeDossierSchema();
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM trade_dossiers
        WHERE (@symbol IS NULL OR symbol = @symbol)
          AND (@status IS NULL OR status = @status)
        ORDER BY created_at DESC, id DESC
        LIMIT @limit
      `
    )
    .all({
      symbol: params.symbol?.trim().toUpperCase() ?? null,
      status: params.status ?? null,
      limit: params.limit ?? 100,
    }) as Array<Record<string, unknown>>;
  return rows.map((row) => rowToTradeDossier(row)).filter((row): row is TradeDossier => row != null);
}
