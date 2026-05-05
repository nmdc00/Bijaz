import type { ExecutionLearningCase } from './execution_learning.js';
import type { TradeArchetype } from './trade_contract.js';
import type { LearningCaseInput } from '../memory/learning_cases.js';

function toFiniteOrNull(input: unknown): number | null {
  const value = Number(input);
  return Number.isFinite(value) ? value : null;
}

function meanOrNull(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (usable.length === 0) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

export interface PerpExecutionLearningCaseInput {
  symbol: string;
  executionMode: 'paper' | 'live';
  tradeId: number | null;
  hypothesisId: string | null;
  capturedAtMs: number;
  side: 'buy' | 'sell';
  size: number;
  leverage: number | null;
  signalClass: string | null;
  marketRegime: string | null;
  volatilityBucket: string | null;
  liquidityBucket: string | null;
  tradeArchetype: TradeArchetype | null;
  entryTrigger: 'news' | 'technical' | 'hybrid' | null;
  expectedEdge: number | null;
  invalidationPrice: number | null;
  timeStopAtMs: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  pricePathHigh: number | null;
  pricePathLow: number | null;
  thesisCorrect: boolean | null;
  thesisInvalidationHit: boolean | null;
  exitMode: string | null;
  realizedPnlUsd: number | null;
  netRealizedPnlUsd: number | null;
  realizedFeeUsd: number | null;
  directionScore: number | null;
  timingScore: number | null;
  sizingScore: number | null;
  exitScore: number | null;
  capturedR: number | null;
  leftOnTableR: number | null;
  wouldHit2R: boolean | null;
  wouldHit3R: boolean | null;
  maeProxy: number | null;
  mfeProxy: number | null;
  reasoning: string | null;
  planContext: Record<string, unknown> | null;
  snapshot: Record<string, unknown> | null;
}

export function buildPerpExecutionLearningCase(
  input: PerpExecutionLearningCaseInput
): ExecutionLearningCase {
  const directionScore = toFiniteOrNull(input.directionScore);
  const timingScore = toFiniteOrNull(input.timingScore);
  const sizingScore = toFiniteOrNull(input.sizingScore);
  const exitScore = toFiniteOrNull(input.exitScore);

  return {
    kind: 'execution_learning_case',
    caseType: 'execution_quality',
    comparable: false,
    domain: 'perp',
    entityType: 'symbol',
    entityId: input.symbol,
    executionMode: input.executionMode,
    sourceTradeId: input.tradeId,
    sourceHypothesisId: input.hypothesisId,
    createdAtMs: input.capturedAtMs,
    context: {
      signalClass: input.signalClass,
      marketRegime: input.marketRegime,
      volatilityBucket: input.volatilityBucket,
      liquidityBucket: input.liquidityBucket,
      tradeArchetype: input.tradeArchetype,
      entryTrigger: input.entryTrigger,
    },
    action: {
      side: input.side,
      reduceOnly: true,
      size: input.size,
      leverage: input.leverage,
      expectedEdge: input.expectedEdge,
      invalidationPrice: input.invalidationPrice,
      timeStopAtMs: input.timeStopAtMs,
      entryPrice: input.entryPrice,
      exitPrice: input.exitPrice,
    },
    outcome: {
      thesisCorrect: input.thesisCorrect,
      thesisInvalidationHit: input.thesisInvalidationHit,
      exitMode: input.exitMode,
      realizedPnlUsd: input.realizedPnlUsd,
      netRealizedPnlUsd: input.netRealizedPnlUsd,
      realizedFeeUsd: input.realizedFeeUsd,
      pricePathHigh: input.pricePathHigh,
      pricePathLow: input.pricePathLow,
    },
    quality: {
      directionScore,
      timingScore,
      sizingScore,
      exitScore,
      capturedR: toFiniteOrNull(input.capturedR),
      leftOnTableR: toFiniteOrNull(input.leftOnTableR),
      wouldHit2R: input.wouldHit2R,
      wouldHit3R: input.wouldHit3R,
      maeProxy: toFiniteOrNull(input.maeProxy),
      mfeProxy: toFiniteOrNull(input.mfeProxy),
      compositeScore: meanOrNull([directionScore, timingScore, sizingScore, exitScore]),
    },
    policyInputs: {
      reasoning: input.reasoning,
      planContext: input.planContext,
    },
    sourceLinks: {
      snapshot: input.snapshot,
    },
  };
}

export function toPerpExecutionLearningCaseInput(
  learningCase: ExecutionLearningCase
): LearningCaseInput {
  return {
    caseType: 'execution_quality',
    domain: learningCase.domain,
    entityType: learningCase.entityType,
    entityId: learningCase.entityId,
    comparable: false,
    comparatorKind: null,
    sourceTradeId: learningCase.sourceTradeId,
    belief: null,
    baseline: null,
    context: learningCase.context as unknown as Record<string, unknown>,
    action: learningCase.action as unknown as Record<string, unknown>,
    outcome: learningCase.outcome as unknown as Record<string, unknown>,
    qualityScores: learningCase.quality as unknown as Record<string, unknown>,
    policyInputs: learningCase.policyInputs as unknown as Record<string, unknown>,
    exclusionReason: 'execution_quality_case',
  };
}
