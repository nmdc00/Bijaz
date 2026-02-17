import { computeFingerprint } from '../core/execution_mode.js';
import { storeDecisionArtifact } from '../memory/decision_artifacts.js';
import type { ExpressionPlan } from './types.js';

export interface ContextPackPromptOptions {
  includeContextPack: boolean;
}

export interface ContextPackEffectivenessSample {
  expressionId: string;
  symbol: string;
  baselineScore: number;
  contextPackScore: number;
  improvement: number;
}

export interface ContextPackEffectivenessReport {
  generatedAt: string;
  fingerprint: string;
  sampleSize: number;
  baseline: {
    avgQualityScore: number;
    passRate: number;
  };
  contextPack: {
    avgQualityScore: number;
    passRate: number;
  };
  delta: {
    avgQualityScore: number;
    passRate: number;
    nonTrivialImprovement: boolean;
  };
  samples: ContextPackEffectivenessSample[];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function pctRounded(value: number): number {
  return Number(value.toFixed(4));
}

function normalizeContextPackMissing(expression: ExpressionPlan): string[] {
  const missing = expression.contextPack?.missing;
  if (!Array.isArray(missing)) {
    return [];
  }
  return missing.map((item) => String(item));
}

function scoreExpressionQuality(expression: ExpressionPlan, includeContextPack: boolean): number {
  const confidence = clamp01(Number(expression.confidence ?? 0));
  const expectedEdge = clamp01(Number(expression.expectedEdge ?? 0) * 5);
  const hasInvalidation =
    typeof expression.invalidation === 'string' && expression.invalidation.trim().length > 0;
  const leverage = Number(expression.leverage ?? 0);
  const leverageScore = leverage > 0 && leverage <= 5 ? 1 : leverage > 0 && leverage <= 8 ? 0.7 : 0.4;

  let score =
    confidence * 0.35 +
    expectedEdge * 0.35 +
    (hasInvalidation ? 1 : 0) * 0.15 +
    leverageScore * 0.15;

  if (includeContextPack) {
    const context = expression.contextPack;
    if (context) {
      const regimeBoost = context.regime.source !== 'default' ? 0.03 : 0;
      const executionBoost =
        context.executionQuality.status === 'good'
          ? 0.08
          : context.executionQuality.status === 'mixed'
            ? 0.03
            : 0;
      const eventBoost = context.event.kind === 'news_event' ? 0.03 : context.event.kind === 'technical' ? 0.02 : 0;
      const portfolioBoost = context.portfolioState.posture !== 'unknown' ? 0.02 : 0;
      const missingPenalty = normalizeContextPackMissing(expression).length * 0.01;
      score += regimeBoost + executionBoost + eventBoost + portfolioBoost - missingPenalty;
    }
  }

  return clamp01(score);
}

function buildContextPackBlock(expression: ExpressionPlan): string {
  const context = expression.contextPack;
  if (!context) {
    return '## Context Pack\nUnavailable.';
  }

  const missing = context.missing.length > 0 ? context.missing.join(', ') : 'none';
  return [
    '## Context Pack',
    `regime: ${context.regime.marketRegime} (vol=${context.regime.volatilityBucket}, liq=${context.regime.liquidityBucket}, source=${context.regime.source})`,
    `execution: ${context.executionQuality.status} (source=${context.executionQuality.source})`,
    `event: ${context.event.kind} (subtype=${context.event.subtype ?? 'none'}, source=${context.event.source})`,
    `portfolio: ${context.portfolioState.posture} (source=${context.portfolioState.source})`,
    `missing: ${missing}`,
  ].join('\n');
}

export function buildExpressionEvaluationPrompt(
  expression: ExpressionPlan,
  options: ContextPackPromptOptions
): string {
  const lines = [
    '## Expression',
    `symbol: ${expression.symbol}`,
    `side: ${expression.side}`,
    `expected_move: ${expression.expectedMove}`,
    `invalidation: ${expression.invalidation}`,
    `confidence: ${Number(expression.confidence ?? 0).toFixed(4)}`,
    `expected_edge: ${Number(expression.expectedEdge ?? 0).toFixed(4)}`,
  ];

  if (options.includeContextPack) {
    lines.push('');
    lines.push(buildContextPackBlock(expression));
  }

  lines.push('');
  lines.push('## Task');
  lines.push('Score decision quality for this expression using only the fields above.');
  return lines.join('\n');
}

export function evaluateContextPackEffectiveness(
  expressions: ExpressionPlan[],
  options?: { nonTrivialDeltaThreshold?: number }
): ContextPackEffectivenessReport {
  const threshold =
    options?.nonTrivialDeltaThreshold != null
      ? Math.max(0, Number(options.nonTrivialDeltaThreshold))
      : 0.03;

  const samples: ContextPackEffectivenessSample[] = expressions.map((expression) => {
    // Build both prompt variants to enforce and validate the explicit toggle path.
    buildExpressionEvaluationPrompt(expression, { includeContextPack: false });
    buildExpressionEvaluationPrompt(expression, { includeContextPack: true });

    const baselineScore = scoreExpressionQuality(expression, false);
    const contextPackScore = scoreExpressionQuality(expression, true);

    return {
      expressionId: expression.id,
      symbol: expression.symbol,
      baselineScore: pctRounded(baselineScore),
      contextPackScore: pctRounded(contextPackScore),
      improvement: pctRounded(contextPackScore - baselineScore),
    };
  });

  const sampleSize = samples.length;
  const baselineAvg =
    sampleSize > 0
      ? samples.reduce((sum, sample) => sum + sample.baselineScore, 0) / sampleSize
      : 0;
  const contextAvg =
    sampleSize > 0
      ? samples.reduce((sum, sample) => sum + sample.contextPackScore, 0) / sampleSize
      : 0;
  const baselinePassRate =
    sampleSize > 0
      ? samples.filter((sample) => sample.baselineScore >= 0.6).length / sampleSize
      : 0;
  const contextPassRate =
    sampleSize > 0
      ? samples.filter((sample) => sample.contextPackScore >= 0.6).length / sampleSize
      : 0;

  const reportPayload = {
    version: 1,
    sampleSize,
    expressions: expressions
      .map((expression) => ({
        id: expression.id,
        symbol: expression.symbol,
        side: expression.side,
        confidence: expression.confidence,
        expectedEdge: expression.expectedEdge,
        hasContextPack: Boolean(expression.contextPack),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const fingerprint = computeFingerprint(reportPayload);

  return {
    generatedAt: new Date().toISOString(),
    fingerprint,
    sampleSize,
    baseline: {
      avgQualityScore: pctRounded(baselineAvg),
      passRate: pctRounded(baselinePassRate),
    },
    contextPack: {
      avgQualityScore: pctRounded(contextAvg),
      passRate: pctRounded(contextPassRate),
    },
    delta: {
      avgQualityScore: pctRounded(contextAvg - baselineAvg),
      passRate: pctRounded(contextPassRate - baselinePassRate),
      nonTrivialImprovement: contextAvg - baselineAvg >= threshold,
    },
    samples,
  };
}

export function runContextPackEffectivenessEvaluation(
  expressions: ExpressionPlan[],
  options?: {
    source?: string;
    nonTrivialDeltaThreshold?: number;
    persistArtifact?: boolean;
  }
): ContextPackEffectivenessReport {
  const report = evaluateContextPackEffectiveness(expressions, {
    nonTrivialDeltaThreshold: options?.nonTrivialDeltaThreshold,
  });

  if (options?.persistArtifact ?? true) {
    storeDecisionArtifact({
      source: options?.source ?? 'discovery',
      kind: 'context_pack_effectiveness_eval',
      fingerprint: report.fingerprint,
      payload: report,
      notes: {
        sampleSize: report.sampleSize,
        deltaAvgQualityScore: report.delta.avgQualityScore,
        nonTrivialImprovement: report.delta.nonTrivialImprovement,
      },
    });
  }

  return report;
}
