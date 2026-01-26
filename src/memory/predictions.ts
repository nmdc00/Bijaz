import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';
import { adjustCashBalance } from './portfolio.js';

export type ConfidenceLevel = 'low' | 'medium' | 'high';
export type Outcome = 'YES' | 'NO';

export interface PredictionInput {
  marketId: string;
  marketTitle: string;
  predictedOutcome?: Outcome;
  predictedProbability?: number;
  confidenceLevel?: ConfidenceLevel;
  confidenceRaw?: number;
  confidenceAdjusted?: number;
  reasoning?: string;
  keyFactors?: string[];
  intelIds?: string[];
  domain?: string;
  // Execution details (for auto-executed trades)
  executed?: boolean;
  executionPrice?: number;
  positionSize?: number;
}

export interface PredictionRecord {
  id: string;
  marketId: string;
  marketTitle: string;
  predictedOutcome?: Outcome;
  predictedProbability?: number;
  confidenceLevel?: ConfidenceLevel;
  confidenceRaw?: number;
  confidenceAdjusted?: number;
  reasoning?: string;
  keyFactors?: string[];
  intelIds?: string[];
  domain?: string;
  createdAt: string;
  executed: boolean;
  executionPrice?: number | null;
  positionSize?: number | null;
  outcome?: Outcome | null;
  outcomeTimestamp?: string | null;
  pnl?: number | null;
}

export interface OpenPositionRecord {
  id: string;
  marketId: string;
  marketTitle: string;
  predictedOutcome?: Outcome;
  executionPrice?: number | null;
  positionSize?: number | null;
  netShares?: number | null;
  createdAt: string;
  currentPrices?: Record<string, number> | number[] | null;
}

function serializeJson(value?: string[]): string | null {
  if (!value || value.length === 0) {
    return null;
  }
  return JSON.stringify(value);
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, number> | number[] | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed as number[];
    }
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, number>;
    }
  } catch {
    return null;
  }
  return null;
}

export function createPrediction(input: PredictionInput): string {
  const db = openDatabase();
  const id = randomUUID();

  const stmt = db.prepare(`
    INSERT INTO predictions (
      id,
      market_id,
      market_title,
      predicted_outcome,
      predicted_probability,
      confidence_level,
      confidence_raw,
      confidence_adjusted,
      reasoning,
      key_factors,
      intel_ids,
      domain,
      executed,
      execution_price,
      position_size
    ) VALUES (
      @id,
      @marketId,
      @marketTitle,
      @predictedOutcome,
      @predictedProbability,
      @confidenceLevel,
      @confidenceRaw,
      @confidenceAdjusted,
      @reasoning,
      @keyFactors,
      @intelIds,
      @domain,
      @executed,
      @executionPrice,
      @positionSize
    )
  `);

  stmt.run({
    id,
    marketId: input.marketId,
    marketTitle: input.marketTitle,
    predictedOutcome: input.predictedOutcome ?? null,
    predictedProbability: input.predictedProbability ?? null,
    confidenceLevel: input.confidenceLevel ?? null,
    confidenceRaw: input.confidenceRaw ?? null,
    confidenceAdjusted: input.confidenceAdjusted ?? null,
    reasoning: input.reasoning ?? null,
    keyFactors: serializeJson(input.keyFactors),
    intelIds: serializeJson(input.intelIds),
    domain: input.domain ?? null,
    executed: input.executed ? 1 : 0,
    executionPrice: input.executionPrice ?? null,
    positionSize: input.positionSize ?? null,
  });

  return id;
}

export function listPredictions(options?: {
  domain?: string;
  limit?: number;
}): PredictionRecord[] {
  const db = openDatabase();
  const limit = options?.limit ?? 20;

  const base = `
    SELECT
      id,
      market_id as marketId,
      market_title as marketTitle,
      predicted_outcome as predictedOutcome,
      predicted_probability as predictedProbability,
      confidence_level as confidenceLevel,
      confidence_raw as confidenceRaw,
      confidence_adjusted as confidenceAdjusted,
      reasoning,
      key_factors as keyFactors,
      intel_ids as intelIds,
      domain,
      created_at as createdAt,
      executed,
      execution_price as executionPrice,
      position_size as positionSize,
      outcome,
      outcome_timestamp as outcomeTimestamp,
      pnl
    FROM predictions
  `;

  let rows: Array<Record<string, unknown>>;
  if (options?.domain) {
    const stmt = db.prepare(
      `${base} WHERE domain = ? ORDER BY created_at DESC LIMIT ?`
    );
    rows = stmt.all(options.domain, limit) as Array<Record<string, unknown>>;
  } else {
    const stmt = db.prepare(`${base} ORDER BY created_at DESC LIMIT ?`);
    rows = stmt.all(limit) as Array<Record<string, unknown>>;
  }

  return rows.map((row) => ({
    id: String(row.id),
    marketId: String(row.marketId),
    marketTitle: String(row.marketTitle),
    predictedOutcome: (row.predictedOutcome as Outcome) ?? undefined,
    predictedProbability: row.predictedProbability as number | undefined,
    confidenceLevel: row.confidenceLevel as ConfidenceLevel | undefined,
    confidenceRaw: row.confidenceRaw as number | undefined,
    confidenceAdjusted: row.confidenceAdjusted as number | undefined,
    reasoning: (row.reasoning as string) ?? undefined,
    keyFactors: parseJsonArray((row.keyFactors as string | null) ?? null),
    intelIds: parseJsonArray((row.intelIds as string | null) ?? null),
    domain: (row.domain as string) ?? undefined,
    createdAt: String(row.createdAt),
    executed: Boolean(row.executed),
    executionPrice: row.executionPrice as number | null,
    positionSize: row.positionSize as number | null,
    outcome: (row.outcome as Outcome | null) ?? null,
    outcomeTimestamp: (row.outcomeTimestamp as string | null) ?? null,
    pnl: row.pnl as number | null,
  }));
}

export function getPrediction(id: string): PredictionRecord | null {
  const db = openDatabase();
  const stmt = db.prepare(
    `
      SELECT
        id,
        market_id as marketId,
        market_title as marketTitle,
        predicted_outcome as predictedOutcome,
        predicted_probability as predictedProbability,
        confidence_level as confidenceLevel,
        confidence_raw as confidenceRaw,
        confidence_adjusted as confidenceAdjusted,
        reasoning,
        key_factors as keyFactors,
        intel_ids as intelIds,
        domain,
        created_at as createdAt,
        executed,
        execution_price as executionPrice,
        position_size as positionSize,
        outcome,
        outcome_timestamp as outcomeTimestamp,
        pnl
      FROM predictions
      WHERE id = ?
      LIMIT 1
    `
  );

  const row = stmt.get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    marketId: String(row.marketId),
    marketTitle: String(row.marketTitle),
    predictedOutcome: (row.predictedOutcome as Outcome) ?? undefined,
    predictedProbability: row.predictedProbability as number | undefined,
    confidenceLevel: row.confidenceLevel as ConfidenceLevel | undefined,
    confidenceRaw: row.confidenceRaw as number | undefined,
    confidenceAdjusted: row.confidenceAdjusted as number | undefined,
    reasoning: (row.reasoning as string) ?? undefined,
    keyFactors: parseJsonArray((row.keyFactors as string | null) ?? null),
    intelIds: parseJsonArray((row.intelIds as string | null) ?? null),
    domain: (row.domain as string) ?? undefined,
    createdAt: String(row.createdAt),
    executed: Boolean(row.executed),
    executionPrice: row.executionPrice as number | null,
    positionSize: row.positionSize as number | null,
    outcome: (row.outcome as Outcome | null) ?? null,
    outcomeTimestamp: (row.outcomeTimestamp as string | null) ?? null,
    pnl: row.pnl as number | null,
  };
}

export function recordExecution(params: {
  id: string;
  executionPrice?: number | null;
  positionSize?: number | null;
  cashDelta?: number | null;
}): void {
  const db = openDatabase();
  const stmt = db.prepare(`
    UPDATE predictions
    SET executed = 1,
        execution_price = @executionPrice,
        position_size = @positionSize
    WHERE id = @id
  `);

  stmt.run({
    id: params.id,
    executionPrice: params.executionPrice ?? null,
    positionSize: params.positionSize ?? null,
  });

  if (params.cashDelta !== null && params.cashDelta !== undefined) {
    adjustCashBalance(params.cashDelta);
    return;
  }

  if (params.positionSize && params.positionSize > 0) {
    adjustCashBalance(-Math.abs(params.positionSize));
  }
}

export function listUnresolvedPredictions(limit = 50): Array<{
  id: string;
  marketId: string;
}> {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT id, market_id as marketId
        FROM predictions
        WHERE outcome IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    marketId: String(row.marketId),
  }));
}

export function listOpenPositions(limit = 50): OpenPositionRecord[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT id,
               market_id as marketId,
               market_title as marketTitle,
               predicted_outcome as predictedOutcome,
               execution_price as executionPrice,
               position_size as positionSize,
               created_at as createdAt,
               current_prices as currentPrices
        FROM open_positions
        LIMIT ?
      `
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    marketId: String(row.marketId),
    marketTitle: String(row.marketTitle),
    predictedOutcome: (row.predictedOutcome as Outcome) ?? undefined,
    executionPrice: row.executionPrice as number | null,
    positionSize: row.positionSize as number | null,
    createdAt: String(row.createdAt),
    currentPrices: parseJsonObject((row.currentPrices as string | null) ?? null),
  }));
}
