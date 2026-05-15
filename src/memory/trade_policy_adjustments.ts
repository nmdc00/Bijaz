import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export type TradePolicyAdjustmentValue = number | string | boolean | null;

export interface TradePolicyAdjustment {
  id: string;
  policyDomain: string;
  policyKey: string;
  scope: Record<string, unknown> | null;
  adjustmentType: string;
  oldValue: TradePolicyAdjustmentValue;
  newValue: TradePolicyAdjustmentValue;
  delta: number | null;
  evidenceCount: number | null;
  evidenceWindowStart: string | null;
  evidenceWindowEnd: string | null;
  reasonSummary: string | null;
  confidence: number | null;
  active: boolean;
  createdAt: string;
  expiresAt: string | null;
}

export interface CreateTradePolicyAdjustmentInput {
  id?: string;
  policyDomain: string;
  policyKey: string;
  scope?: Record<string, unknown> | null;
  adjustmentType: string;
  oldValue?: TradePolicyAdjustmentValue;
  newValue?: TradePolicyAdjustmentValue;
  delta?: number | null;
  evidenceCount?: number | null;
  evidenceWindowStart?: string | null;
  evidenceWindowEnd?: string | null;
  reasonSummary?: string | null;
  confidence?: number | null;
  active?: boolean;
  expiresAt?: string | null;
}

export interface ListTradePolicyAdjustmentsFilters {
  policyDomain?: string;
  policyKey?: string;
  active?: boolean;
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

function serializeScalar(value: TradePolicyAdjustmentValue | undefined): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function parseScalar(
  payload: string | null,
  fallback: unknown
): TradePolicyAdjustmentValue {
  if (payload) {
    try {
      return JSON.parse(payload) as TradePolicyAdjustmentValue;
    } catch {
      // Fall through to legacy scalar columns.
    }
  }
  if (fallback == null) return null;
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
  if (typeof fallback === 'string') {
    const normalized = fallback.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return fallback;
  }
  if (typeof fallback === 'boolean') return fallback;
  return null;
}

function ensureTradePolicyAdjustmentsSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_policy_adjustments (
      id TEXT PRIMARY KEY,
      policy_domain TEXT NOT NULL,
      policy_key TEXT NOT NULL,
      scope_payload TEXT,
      adjustment_type TEXT NOT NULL,
      old_value REAL,
      new_value REAL,
      old_value_payload TEXT,
      new_value_payload TEXT,
      delta REAL,
      evidence_count INTEGER,
      evidence_window_start TEXT,
      evidence_window_end TEXT,
      reason_summary TEXT,
      confidence REAL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trade_policy_adjustments_domain_key
      ON trade_policy_adjustments(policy_domain, policy_key);
    CREATE INDEX IF NOT EXISTS idx_trade_policy_adjustments_active
      ON trade_policy_adjustments(active, created_at);
  `);

  const columns = db
    .prepare("PRAGMA table_info('trade_policy_adjustments')")
    .all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  const addColumnIfMissing = (name: string, definition: string): void => {
    if (columnNames.has(name)) return;
    db.exec(`ALTER TABLE trade_policy_adjustments ADD COLUMN ${definition}`);
    columnNames.add(name);
  };

  addColumnIfMissing('old_value_payload', 'old_value_payload TEXT');
  addColumnIfMissing('new_value_payload', 'new_value_payload TEXT');
}

function toTradePolicyAdjustment(row: Record<string, unknown>): TradePolicyAdjustment {
  return {
    id: String(row.id ?? ''),
    policyDomain: String(row.policy_domain ?? ''),
    policyKey: String(row.policy_key ?? ''),
    scope: parseJson(typeof row.scope_payload === 'string' ? row.scope_payload : null),
    adjustmentType: String(row.adjustment_type ?? ''),
    oldValue: parseScalar(
      typeof row.old_value_payload === 'string' ? row.old_value_payload : null,
      row.old_value
    ),
    newValue: parseScalar(
      typeof row.new_value_payload === 'string' ? row.new_value_payload : null,
      row.new_value
    ),
    delta: row.delta == null ? null : Number(row.delta),
    evidenceCount: row.evidence_count == null ? null : Number(row.evidence_count),
    evidenceWindowStart:
      row.evidence_window_start == null ? null : String(row.evidence_window_start),
    evidenceWindowEnd: row.evidence_window_end == null ? null : String(row.evidence_window_end),
    reasonSummary: row.reason_summary == null ? null : String(row.reason_summary),
    confidence: row.confidence == null ? null : Number(row.confidence),
    active: Number(row.active ?? 0) === 1,
    createdAt: String(row.created_at ?? ''),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
  };
}

export function createTradePolicyAdjustment(
  input: CreateTradePolicyAdjustmentInput
): TradePolicyAdjustment {
  ensureTradePolicyAdjustmentsSchema();
  const db = openDatabase();
  const id = input.id ?? randomUUID();
  db.prepare(
    `
      INSERT INTO trade_policy_adjustments (
        id,
        policy_domain,
        policy_key,
        scope_payload,
        adjustment_type,
        old_value,
        new_value,
        old_value_payload,
        new_value_payload,
        delta,
        evidence_count,
        evidence_window_start,
        evidence_window_end,
        reason_summary,
        confidence,
        active,
        expires_at
      ) VALUES (
        @id,
        @policyDomain,
        @policyKey,
        @scopePayload,
        @adjustmentType,
        @oldValue,
        @newValue,
        @oldValuePayload,
        @newValuePayload,
        @delta,
        @evidenceCount,
        @evidenceWindowStart,
        @evidenceWindowEnd,
        @reasonSummary,
        @confidence,
        @active,
        @expiresAt
      )
    `
  ).run({
    id,
    policyDomain: input.policyDomain,
    policyKey: input.policyKey,
    scopePayload: serializeJson(input.scope),
    adjustmentType: input.adjustmentType,
    oldValue: typeof input.oldValue === 'number' ? input.oldValue : null,
    newValue: typeof input.newValue === 'number' ? input.newValue : null,
    oldValuePayload: serializeScalar(input.oldValue),
    newValuePayload: serializeScalar(input.newValue),
    delta: input.delta ?? null,
    evidenceCount: input.evidenceCount ?? null,
    evidenceWindowStart: input.evidenceWindowStart ?? null,
    evidenceWindowEnd: input.evidenceWindowEnd ?? null,
    reasonSummary: input.reasonSummary ?? null,
    confidence: input.confidence ?? null,
    active: input.active === false ? 0 : 1,
    expiresAt: input.expiresAt ?? null,
  });

  return getTradePolicyAdjustmentById(id);
}

export function getTradePolicyAdjustmentById(id: string): TradePolicyAdjustment {
  ensureTradePolicyAdjustmentsSchema();
  const db = openDatabase();
  const row = db
    .prepare('SELECT * FROM trade_policy_adjustments WHERE id = ? LIMIT 1')
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Trade policy adjustment not found: ${id}`);
  }
  return toTradePolicyAdjustment(row);
}

export function deactivateTradePolicyAdjustment(
  id: string,
  expiresAt: string | null = null
): TradePolicyAdjustment {
  ensureTradePolicyAdjustmentsSchema();
  const db = openDatabase();
  db.prepare(
    `
      UPDATE trade_policy_adjustments
      SET active = 0,
          expires_at = COALESCE(@expiresAt, expires_at, datetime('now'))
      WHERE id = @id
    `
  ).run({
    id,
    expiresAt,
  });
  return getTradePolicyAdjustmentById(id);
}

export function listTradePolicyAdjustments(
  filters: ListTradePolicyAdjustmentsFilters = {}
): TradePolicyAdjustment[] {
  ensureTradePolicyAdjustmentsSchema();
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM trade_policy_adjustments
        WHERE (@policyDomain IS NULL OR policy_domain = @policyDomain)
          AND (@policyKey IS NULL OR policy_key = @policyKey)
          AND (@active IS NULL OR active = @active)
        ORDER BY created_at DESC, id DESC
        LIMIT @limit
      `
    )
    .all({
      policyDomain: filters.policyDomain ?? null,
      policyKey: filters.policyKey ?? null,
      active: filters.active === undefined ? null : filters.active ? 1 : 0,
      limit: filters.limit ?? 100,
    }) as Array<Record<string, unknown>>;
  return rows.map(toTradePolicyAdjustment);
}
