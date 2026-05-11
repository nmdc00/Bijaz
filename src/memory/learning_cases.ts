import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export type LearningCaseType = 'comparable_forecast' | 'execution_quality';

export interface LearningCasePayloadMap {
  belief?: Record<string, unknown> | null;
  baseline?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
  action?: Record<string, unknown> | null;
  outcome?: Record<string, unknown> | null;
  qualityScores?: Record<string, unknown> | null;
  policyInputs?: Record<string, unknown> | null;
}

export interface LearningCaseSourceLinks {
  sourcePredictionId?: string | null;
  sourceTradeId?: number | null;
  sourceArtifactId?: number | null;
}

export interface LearningCaseInput extends LearningCasePayloadMap, LearningCaseSourceLinks {
  id?: string;
  caseType: LearningCaseType;
  domain: string;
  entityType: string;
  entityId: string;
  comparable: boolean;
  comparatorKind?: string | null;
  exclusionReason?: string | null;
}

export interface LearningCase extends LearningCasePayloadMap, LearningCaseSourceLinks {
  id: string;
  caseType: LearningCaseType;
  domain: string;
  entityType: string;
  entityId: string;
  comparable: boolean;
  comparatorKind: string | null;
  exclusionReason: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface UpdateLearningCaseOutcomeInput {
  id: string;
  outcome?: Record<string, unknown> | null;
  qualityScores?: Record<string, unknown> | null;
  policyInputs?: Record<string, unknown> | null;
  comparable?: boolean;
  comparatorKind?: string | null;
  exclusionReason?: string | null;
}

export interface ListLearningCasesFilters {
  caseType?: LearningCaseType;
  domain?: string;
  comparable?: boolean;
  entityType?: string;
  entityId?: string;
  sourcePredictionId?: string;
  sourceTradeId?: number;
  sourceArtifactId?: number;
  limit?: number;
}

type LearningCaseRow = {
  id: string;
  case_type: LearningCaseType;
  domain: string;
  entity_type: string;
  entity_id: string;
  comparable: number;
  comparator_kind: string | null;
  source_prediction_id: string | null;
  source_trade_id: number | null;
  source_artifact_id: number | null;
  belief_payload: string | null;
  baseline_payload: string | null;
  context_payload: string | null;
  action_payload: string | null;
  outcome_payload: string | null;
  quality_payload: string | null;
  policy_input_payload: string | null;
  exclusion_reason: string | null;
  created_at: string;
  updated_at: string | null;
};

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

function toLearningCase(row: LearningCaseRow): LearningCase {
  return {
    id: row.id,
    caseType: row.case_type,
    domain: row.domain,
    entityType: row.entity_type,
    entityId: row.entity_id,
    comparable: row.comparable === 1,
    comparatorKind: row.comparator_kind,
    sourcePredictionId: row.source_prediction_id,
    sourceTradeId: row.source_trade_id,
    sourceArtifactId: row.source_artifact_id,
    belief: parseJson(row.belief_payload),
    baseline: parseJson(row.baseline_payload),
    context: parseJson(row.context_payload),
    action: parseJson(row.action_payload),
    outcome: parseJson(row.outcome_payload),
    qualityScores: parseJson(row.quality_payload),
    policyInputs: parseJson(row.policy_input_payload),
    exclusionReason: row.exclusion_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createLearningCase(input: LearningCaseInput): LearningCase {
  const db = openDatabase();
  const id = input.id ?? randomUUID();
  db.prepare(
    `
      INSERT INTO learning_cases (
        id,
        case_type,
        domain,
        entity_type,
        entity_id,
        comparable,
        comparator_kind,
        source_prediction_id,
        source_trade_id,
        source_artifact_id,
        belief_payload,
        baseline_payload,
        context_payload,
        action_payload,
        outcome_payload,
        quality_payload,
        policy_input_payload,
        exclusion_reason
      ) VALUES (
        @id,
        @caseType,
        @domain,
        @entityType,
        @entityId,
        @comparable,
        @comparatorKind,
        @sourcePredictionId,
        @sourceTradeId,
        @sourceArtifactId,
        @belief,
        @baseline,
        @context,
        @action,
        @outcome,
        @qualityScores,
        @policyInputs,
        @exclusionReason
      )
    `
  ).run({
    id,
    caseType: input.caseType,
    domain: input.domain,
    entityType: input.entityType,
    entityId: input.entityId,
    comparable: input.comparable ? 1 : 0,
    comparatorKind: input.comparatorKind ?? null,
    sourcePredictionId: input.sourcePredictionId ?? null,
    sourceTradeId: input.sourceTradeId ?? null,
    sourceArtifactId: input.sourceArtifactId ?? null,
    belief: serializeJson(input.belief),
    baseline: serializeJson(input.baseline),
    context: serializeJson(input.context),
    action: serializeJson(input.action),
    outcome: serializeJson(input.outcome),
    qualityScores: serializeJson(input.qualityScores),
    policyInputs: serializeJson(input.policyInputs),
    exclusionReason: input.exclusionReason ?? null,
  });

  return getLearningCaseById(id);
}

export function getLearningCaseById(id: string): LearningCase {
  const db = openDatabase();
  const row = db.prepare('SELECT * FROM learning_cases WHERE id = ?').get(id) as
    | LearningCaseRow
    | undefined;
  if (!row) {
    throw new Error(`Learning case not found: ${id}`);
  }
  return toLearningCase(row);
}

export function updateLearningCaseOutcome(input: UpdateLearningCaseOutcomeInput): LearningCase {
  const db = openDatabase();
  db.prepare(
    `
      UPDATE learning_cases
      SET outcome_payload = COALESCE(@outcome, outcome_payload),
          quality_payload = COALESCE(@qualityScores, quality_payload),
          policy_input_payload = COALESCE(@policyInputs, policy_input_payload),
          comparable = COALESCE(@comparable, comparable),
          comparator_kind = COALESCE(@comparatorKind, comparator_kind),
          exclusion_reason = COALESCE(@exclusionReason, exclusion_reason),
          updated_at = datetime('now')
      WHERE id = @id
    `
  ).run({
    id: input.id,
    outcome: input.outcome === undefined ? null : serializeJson(input.outcome),
    qualityScores: input.qualityScores === undefined ? null : serializeJson(input.qualityScores),
    policyInputs: input.policyInputs === undefined ? null : serializeJson(input.policyInputs),
    comparable: input.comparable === undefined ? null : input.comparable ? 1 : 0,
    comparatorKind: input.comparatorKind === undefined ? null : input.comparatorKind,
    exclusionReason: input.exclusionReason === undefined ? null : input.exclusionReason,
  });

  return getLearningCaseById(input.id);
}

export function listLearningCases(filters: ListLearningCasesFilters = {}): LearningCase[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM learning_cases
        WHERE (@caseType IS NULL OR case_type = @caseType)
          AND (@domain IS NULL OR domain = @domain)
          AND (@comparable IS NULL OR comparable = @comparable)
          AND (@entityType IS NULL OR entity_type = @entityType)
          AND (@entityId IS NULL OR entity_id = @entityId)
          AND (@sourcePredictionId IS NULL OR source_prediction_id = @sourcePredictionId)
          AND (@sourceTradeId IS NULL OR source_trade_id = @sourceTradeId)
          AND (@sourceArtifactId IS NULL OR source_artifact_id = @sourceArtifactId)
        ORDER BY created_at DESC, id DESC
        LIMIT @limit
      `
    )
    .all({
      caseType: filters.caseType ?? null,
      domain: filters.domain ?? null,
      comparable: filters.comparable === undefined ? null : filters.comparable ? 1 : 0,
      entityType: filters.entityType ?? null,
      entityId: filters.entityId ?? null,
      sourcePredictionId: filters.sourcePredictionId ?? null,
      sourceTradeId: filters.sourceTradeId ?? null,
      sourceArtifactId: filters.sourceArtifactId ?? null,
      limit: filters.limit ?? 100,
    }) as LearningCaseRow[];

  return rows.map(toLearningCase);
}
