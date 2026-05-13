import type Database from 'better-sqlite3';

import { openDatabase } from './db.js';
import type { SignalWeights } from './learning.js';

export const DEFAULT_RUNTIME_RUN_ID = 'default';
export const DEFAULT_RUNTIME_POLICY_VERSION = 'default';

export type LearningRuntimeContext = {
  runId: string;
  policyVersion: string;
  updatedAt: string | null;
  source: 'db' | 'env' | 'default';
};

export type WeightedSignalSnapshot = {
  combinedScore: number;
  confidence: number;
  direction: 'long' | 'short' | 'neutral';
};

function normalizeRuntimeValue(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : fallback;
}

export function getLearningRuntimeContext(
  db: Database.Database = openDatabase()
): LearningRuntimeContext {
  try {
    const row = db.prepare(
      `
        SELECT run_id AS runId, policy_version AS policyVersion, updated_at AS updatedAt
        FROM learning_runtime_state
        WHERE id = 1
      `
    ).get() as { runId?: string | null; policyVersion?: string | null; updatedAt?: string | null } | undefined;
    if (row?.runId && row?.policyVersion) {
      return {
        runId: normalizeRuntimeValue(row.runId, DEFAULT_RUNTIME_RUN_ID),
        policyVersion: normalizeRuntimeValue(row.policyVersion, DEFAULT_RUNTIME_POLICY_VERSION),
        updatedAt: row.updatedAt ?? null,
        source: 'db',
      };
    }
  } catch {
    // Fall through to env/default sources.
  }

  const envRunId = String(process.env.THUFIR_RUN_ID ?? '').trim();
  const envPolicyVersion = String(process.env.THUFIR_POLICY_VERSION ?? '').trim();
  if (envRunId || envPolicyVersion) {
    return {
      runId: normalizeRuntimeValue(envRunId, DEFAULT_RUNTIME_RUN_ID),
      policyVersion: normalizeRuntimeValue(envPolicyVersion, DEFAULT_RUNTIME_POLICY_VERSION),
      updatedAt: null,
      source: 'env',
    };
  }

  return {
    runId: DEFAULT_RUNTIME_RUN_ID,
    policyVersion: DEFAULT_RUNTIME_POLICY_VERSION,
    updatedAt: null,
    source: 'default',
  };
}

export function setLearningRuntimeContext(
  input: { runId: string; policyVersion?: string | null },
  db: Database.Database = openDatabase()
): LearningRuntimeContext {
  const runId = normalizeRuntimeValue(input.runId, DEFAULT_RUNTIME_RUN_ID);
  const policyVersion = normalizeRuntimeValue(
    input.policyVersion ?? DEFAULT_RUNTIME_POLICY_VERSION,
    DEFAULT_RUNTIME_POLICY_VERSION
  );

  db.prepare(
    `
      INSERT INTO learning_runtime_state (id, run_id, policy_version, updated_at)
      VALUES (1, @runId, @policyVersion, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        run_id = excluded.run_id,
        policy_version = excluded.policy_version,
        updated_at = excluded.updated_at
    `
  ).run({ runId, policyVersion });

  return getLearningRuntimeContext(db);
}

export function computeWeightedSignalSnapshot(
  scores: SignalWeights,
  weights: SignalWeights
): WeightedSignalSnapshot {
  const combinedScore =
    scores.technical * weights.technical +
    scores.news * weights.news +
    scores.onChain * weights.onChain;
  const aligned =
    Math.sign(scores.technical) === Math.sign(scores.news) &&
    Math.sign(scores.technical) === Math.sign(scores.onChain);
  const confidence = aligned ? Math.abs(combinedScore) : Math.abs(combinedScore) * 0.5;
  const direction =
    combinedScore > 0.2 ? 'long' : combinedScore < -0.2 ? 'short' : 'neutral';

  return {
    combinedScore,
    confidence,
    direction,
  };
}

export function recordLearningSignalAudit(input: {
  learningEventId: number | null;
  predictionId?: string | null;
  domain: string;
  signalScores: SignalWeights;
  defaultWeights: SignalWeights;
  decisionWeights: SignalWeights;
  activeWeightsBefore: SignalWeights;
  activeWeightsAfter: SignalWeights;
  db?: Database.Database;
}): void {
  const db = input.db ?? openDatabase();
  const runtime = getLearningRuntimeContext(db);
  const baseline = computeWeightedSignalSnapshot(input.signalScores, input.defaultWeights);
  const decision = computeWeightedSignalSnapshot(input.signalScores, input.decisionWeights);
  const activeBefore = computeWeightedSignalSnapshot(input.signalScores, input.activeWeightsBefore);
  const activeAfter = computeWeightedSignalSnapshot(input.signalScores, input.activeWeightsAfter);

  const changedVsDefault =
    decision.direction !== baseline.direction ||
    Math.abs(decision.confidence - baseline.confidence) > 1e-9 ||
    Math.abs(decision.combinedScore - baseline.combinedScore) > 1e-9;
  const changedAfterUpdate =
    activeAfter.direction !== decision.direction ||
    Math.abs(activeAfter.confidence - decision.confidence) > 1e-9 ||
    Math.abs(activeAfter.combinedScore - decision.combinedScore) > 1e-9;

  db.prepare(
    `
      INSERT INTO learning_signal_audits (
        learning_event_id,
        prediction_id,
        domain,
        run_id,
        policy_version,
        signal_scores,
        default_weights,
        decision_weights,
        active_weights_before,
        active_weights_after,
        baseline_direction,
        decision_direction,
        active_direction_before,
        active_direction_after,
        baseline_confidence,
        decision_confidence,
        active_confidence_before,
        active_confidence_after,
        baseline_score,
        decision_score,
        active_score_before,
        active_score_after,
        changed_vs_default,
        changed_after_update
      ) VALUES (
        @learningEventId,
        @predictionId,
        @domain,
        @runId,
        @policyVersion,
        @signalScores,
        @defaultWeights,
        @decisionWeights,
        @activeWeightsBefore,
        @activeWeightsAfter,
        @baselineDirection,
        @decisionDirection,
        @activeDirectionBefore,
        @activeDirectionAfter,
        @baselineConfidence,
        @decisionConfidence,
        @activeConfidenceBefore,
        @activeConfidenceAfter,
        @baselineScore,
        @decisionScore,
        @activeScoreBefore,
        @activeScoreAfter,
        @changedVsDefault,
        @changedAfterUpdate
      )
    `
  ).run({
    learningEventId: input.learningEventId,
    predictionId: input.predictionId ?? null,
    domain: normalizeRuntimeValue(input.domain, 'global'),
    runId: runtime.runId,
    policyVersion: runtime.policyVersion,
    signalScores: JSON.stringify(input.signalScores),
    defaultWeights: JSON.stringify(input.defaultWeights),
    decisionWeights: JSON.stringify(input.decisionWeights),
    activeWeightsBefore: JSON.stringify(input.activeWeightsBefore),
    activeWeightsAfter: JSON.stringify(input.activeWeightsAfter),
    baselineDirection: baseline.direction,
    decisionDirection: decision.direction,
    activeDirectionBefore: activeBefore.direction,
    activeDirectionAfter: activeAfter.direction,
    baselineConfidence: baseline.confidence,
    decisionConfidence: decision.confidence,
    activeConfidenceBefore: activeBefore.confidence,
    activeConfidenceAfter: activeAfter.confidence,
    baselineScore: baseline.combinedScore,
    decisionScore: decision.combinedScore,
    activeScoreBefore: activeBefore.combinedScore,
    activeScoreAfter: activeAfter.combinedScore,
    changedVsDefault: changedVsDefault ? 1 : 0,
    changedAfterUpdate: changedAfterUpdate ? 1 : 0,
  });
}
