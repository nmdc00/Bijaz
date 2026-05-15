import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export type TradeCounterfactualType =
  | 'no_trade'
  | 'full_size'
  | 'approved_size'
  | 'delay_entry'
  | 'invalidation_exit'
  | 'ttl_exit'
  | 'alternate_expression'
  | 'leverage_cap';

export interface TradeCounterfactual {
  id: string;
  dossierId: string;
  counterfactualType: TradeCounterfactualType;
  baselineKind: string | null;
  summary: string | null;
  score: number | null;
  estimatedNetPnlUsd: number | null;
  estimatedRMultiple: number | null;
  valueAddUsd: number | null;
  confidence: number | null;
  inputs: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  createdAt: string;
}

export interface CreateTradeCounterfactualInput {
  id?: string;
  dossierId: string;
  counterfactualType: TradeCounterfactualType;
  baselineKind?: string | null;
  summary?: string | null;
  score?: number | null;
  estimatedNetPnlUsd?: number | null;
  estimatedRMultiple?: number | null;
  valueAddUsd?: number | null;
  confidence?: number | null;
  inputs?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
}

export interface ListTradeCounterfactualsFilters {
  dossierId?: string;
  counterfactualType?: TradeCounterfactualType;
  limit?: number;
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

function ensureTradeCounterfactualSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_counterfactuals (
      id TEXT PRIMARY KEY,
      dossier_id TEXT NOT NULL,
      counterfactual_type TEXT NOT NULL CHECK(counterfactual_type IN (
        'no_trade',
        'full_size',
        'approved_size',
        'delay_entry',
        'invalidation_exit',
        'ttl_exit',
        'alternate_expression',
        'leverage_cap'
      )),
      baseline_kind TEXT,
      summary TEXT,
      score REAL,
      estimated_net_pnl_usd REAL,
      estimated_r_multiple REAL,
      value_add_usd REAL,
      confidence REAL,
      inputs_payload TEXT,
      result_payload TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trade_counterfactuals_dossier ON trade_counterfactuals(dossier_id);
    CREATE INDEX IF NOT EXISTS idx_trade_counterfactuals_type ON trade_counterfactuals(counterfactual_type);
  `);
}

function toTradeCounterfactual(row: Record<string, unknown>): TradeCounterfactual {
  return {
    id: String(row.id ?? ''),
    dossierId: String(row.dossier_id ?? ''),
    counterfactualType: row.counterfactual_type as TradeCounterfactualType,
    baselineKind: row.baseline_kind == null ? null : String(row.baseline_kind),
    summary: row.summary == null ? null : String(row.summary),
    score: row.score == null ? null : Number(row.score),
    estimatedNetPnlUsd:
      row.estimated_net_pnl_usd == null ? null : Number(row.estimated_net_pnl_usd),
    estimatedRMultiple:
      row.estimated_r_multiple == null ? null : Number(row.estimated_r_multiple),
    valueAddUsd: row.value_add_usd == null ? null : Number(row.value_add_usd),
    confidence: row.confidence == null ? null : Number(row.confidence),
    inputs: parseJson(typeof row.inputs_payload === 'string' ? row.inputs_payload : null),
    result: parseJson(typeof row.result_payload === 'string' ? row.result_payload : null),
    createdAt: String(row.created_at ?? ''),
  };
}

export function createTradeCounterfactual(
  input: CreateTradeCounterfactualInput
): TradeCounterfactual {
  ensureTradeCounterfactualSchema();
  const db = openDatabase();
  const id = input.id ?? randomUUID();
  db.prepare(
    `
      INSERT INTO trade_counterfactuals (
        id,
        dossier_id,
        counterfactual_type,
        baseline_kind,
        summary,
        score,
        estimated_net_pnl_usd,
        estimated_r_multiple,
        value_add_usd,
        confidence,
        inputs_payload,
        result_payload
      ) VALUES (
        @id,
        @dossierId,
        @counterfactualType,
        @baselineKind,
        @summary,
        @score,
        @estimatedNetPnlUsd,
        @estimatedRMultiple,
        @valueAddUsd,
        @confidence,
        @inputsPayload,
        @resultPayload
      )
    `
  ).run({
    id,
    dossierId: input.dossierId,
    counterfactualType: input.counterfactualType,
    baselineKind: input.baselineKind ?? null,
    summary: input.summary ?? null,
    score: input.score ?? null,
    estimatedNetPnlUsd: input.estimatedNetPnlUsd ?? null,
    estimatedRMultiple: input.estimatedRMultiple ?? null,
    valueAddUsd: input.valueAddUsd ?? null,
    confidence: input.confidence ?? null,
    inputsPayload: serializeJson(input.inputs),
    resultPayload: serializeJson(input.result),
  });

  return getTradeCounterfactualById(id);
}

export function getTradeCounterfactualById(id: string): TradeCounterfactual {
  ensureTradeCounterfactualSchema();
  const db = openDatabase();
  const row = db
    .prepare('SELECT * FROM trade_counterfactuals WHERE id = ? LIMIT 1')
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Trade counterfactual not found: ${id}`);
  }
  return toTradeCounterfactual(row);
}

export function listTradeCounterfactuals(
  filters: ListTradeCounterfactualsFilters = {}
): TradeCounterfactual[] {
  ensureTradeCounterfactualSchema();
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM trade_counterfactuals
        WHERE (@dossierId IS NULL OR dossier_id = @dossierId)
          AND (@counterfactualType IS NULL OR counterfactual_type = @counterfactualType)
        ORDER BY created_at DESC, id DESC
        LIMIT @limit
      `
    )
    .all({
      dossierId: filters.dossierId ?? null,
      counterfactualType: filters.counterfactualType ?? null,
      limit: filters.limit ?? 100,
    }) as Array<Record<string, unknown>>;
  return rows.map(toTradeCounterfactual);
}
