import type { LearningCaseInput } from '../memory/learning_cases.js';

function toFiniteOrNull(input: unknown): number | null {
  const value = Number(input);
  return Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function meanOrNull(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (usable.length === 0) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

export type GateInterventionVerdict = 'approve' | 'resize' | 'reject' | 'unknown';

export interface PerpInterventionCounterfactualInput {
  requestedSize?: number | null;
  approvedSize?: number | null;
  requestedLeverage?: number | null;
  approvedLeverage?: number | null;
  netRealizedPnlUsd?: number | null;
  realizedFeeUsd?: number | null;
  gateVerdict?: string | null;
}

export interface PerpInterventionEvidence {
  gateVerdict: GateInterventionVerdict;
  requestedSize: number | null;
  approvedSize: number | null;
  requestedLeverage: number | null;
  approvedLeverage: number | null;
  sizeFillRatio: number | null;
  leverageFillRatio: number | null;
  fullRequestSizeCounterfactualNetPnlUsd: number | null;
  rejectBaselineNetPnlUsd: number | null;
  resizeValueAddUsd: number | null;
  leverageCapValueAddUsd: number | null;
  interventionScore: number | null;
}

export interface PerpThesisLearningCaseDescriptor {
  sourceTradeId: number | null;
  sourceDossierId: string | null;
  sourceHypothesisId: string | null;
  createdAtMs: number | null;
  executionMode: 'paper' | 'live' | null;
  symbol: string;
  context: {
    signalClass: string | null;
    marketRegime: string | null;
    volatilityBucket: string | null;
    liquidityBucket: string | null;
    tradeArchetype: string | null;
    entryTrigger: string | null;
  };
  action: {
    side: 'buy' | 'sell' | null;
    size: number | null;
    leverage: number | null;
    expectedEdge: number | null;
    invalidationPrice: number | null;
    entryPrice: number | null;
    exitPrice: number | null;
  };
  outcome: {
    thesisCorrect: boolean | null;
    thesisInvalidationHit: boolean | null;
    exitMode: string | null;
    realizedPnlUsd: number | null;
    netRealizedPnlUsd: number | null;
    pricePathHigh: number | null;
    pricePathLow: number | null;
  };
  quality: {
    thesisScore: number | null;
    thesisConfidenceScore: number | null;
    thesisPathScore: number | null;
    thesisCompositeScore: number | null;
  };
  policyInputs: {
    reasoning: string | null;
    planContext: Record<string, unknown> | null;
    interventionEvidence: PerpInterventionEvidence | null;
  };
  sourceLinks: {
    snapshot: Record<string, unknown> | null;
  };
}

export function computePerpInterventionEvidence(
  input: PerpInterventionCounterfactualInput
): PerpInterventionEvidence | null {
  const requestedSize = toFiniteOrNull(input.requestedSize);
  const approvedSize = toFiniteOrNull(input.approvedSize);
  const requestedLeverage = toFiniteOrNull(input.requestedLeverage);
  const approvedLeverage = toFiniteOrNull(input.approvedLeverage);
  const netRealizedPnlUsd = toFiniteOrNull(input.netRealizedPnlUsd);
  const gateVerdictRaw = String(input.gateVerdict ?? '').trim().toLowerCase();
  const gateVerdict: GateInterventionVerdict =
    gateVerdictRaw === 'approve' || gateVerdictRaw === 'resize' || gateVerdictRaw === 'reject'
      ? (gateVerdictRaw as GateInterventionVerdict)
      : 'unknown';

  const hasSignal =
    requestedSize != null ||
    approvedSize != null ||
    requestedLeverage != null ||
    approvedLeverage != null ||
    netRealizedPnlUsd != null ||
    gateVerdict !== 'unknown';
  if (!hasSignal) {
    return null;
  }

  const sizeFillRatio =
    requestedSize != null && requestedSize > 0 && approvedSize != null
      ? approvedSize / requestedSize
      : null;
  const leverageFillRatio =
    requestedLeverage != null && requestedLeverage > 0 && approvedLeverage != null
      ? approvedLeverage / requestedLeverage
      : null;
  const fullRequestSizeCounterfactualNetPnlUsd =
    netRealizedPnlUsd != null && approvedSize != null && approvedSize > 0 && requestedSize != null
      ? netRealizedPnlUsd * (requestedSize / approvedSize)
      : null;
  const fullRequestLeverageCounterfactualNetPnlUsd =
    netRealizedPnlUsd != null &&
    approvedLeverage != null &&
    approvedLeverage > 0 &&
    requestedLeverage != null
      ? netRealizedPnlUsd * (requestedLeverage / approvedLeverage)
      : null;
  const resizeValueAddUsd =
    netRealizedPnlUsd != null && fullRequestSizeCounterfactualNetPnlUsd != null
      ? netRealizedPnlUsd - fullRequestSizeCounterfactualNetPnlUsd
      : null;
  const leverageCapValueAddUsd =
    netRealizedPnlUsd != null && fullRequestLeverageCounterfactualNetPnlUsd != null
      ? netRealizedPnlUsd - fullRequestLeverageCounterfactualNetPnlUsd
      : null;
  const interventionScore = meanOrNull([
    resizeValueAddUsd != null ? clamp(resizeValueAddUsd / 50, -1, 1) : null,
    leverageCapValueAddUsd != null ? clamp(leverageCapValueAddUsd / 50, -1, 1) : null,
    netRealizedPnlUsd != null ? clamp(netRealizedPnlUsd / 50, -1, 1) : null,
  ]);

  return {
    gateVerdict,
    requestedSize,
    approvedSize,
    requestedLeverage,
    approvedLeverage,
    sizeFillRatio,
    leverageFillRatio,
    fullRequestSizeCounterfactualNetPnlUsd,
    rejectBaselineNetPnlUsd: 0,
    resizeValueAddUsd,
    leverageCapValueAddUsd,
    interventionScore,
  };
}

export function buildPerpThesisLearningCaseInput(
  descriptor: PerpThesisLearningCaseDescriptor
): LearningCaseInput {
  return {
    caseType: 'thesis_quality',
    domain: 'perp',
    entityType: 'symbol',
    entityId: descriptor.symbol,
    comparable: false,
    comparatorKind: null,
    sourceTradeId: descriptor.sourceTradeId,
    sourceDossierId: descriptor.sourceDossierId,
    belief: {
      thesisCorrect: descriptor.outcome.thesisCorrect,
      thesisScore: descriptor.quality.thesisScore,
      thesisConfidenceScore: descriptor.quality.thesisConfidenceScore,
      thesisPathScore: descriptor.quality.thesisPathScore,
    },
    baseline: descriptor.policyInputs.interventionEvidence
      ? {
          rejectBaselineNetPnlUsd:
            descriptor.policyInputs.interventionEvidence.rejectBaselineNetPnlUsd,
          fullRequestSizeCounterfactualNetPnlUsd:
            descriptor.policyInputs.interventionEvidence.fullRequestSizeCounterfactualNetPnlUsd,
        }
      : null,
    context: descriptor.context as unknown as Record<string, unknown>,
    action: descriptor.action as unknown as Record<string, unknown>,
    outcome: descriptor.outcome as unknown as Record<string, unknown>,
    qualityScores: {
      thesisScore: descriptor.quality.thesisScore,
      thesisConfidenceScore: descriptor.quality.thesisConfidenceScore,
      thesisPathScore: descriptor.quality.thesisPathScore,
      thesisCompositeScore: descriptor.quality.thesisCompositeScore,
    },
    policyInputs: {
      reasoning: descriptor.policyInputs.reasoning,
      planContext: descriptor.policyInputs.planContext,
      interventionEvidence: descriptor.policyInputs.interventionEvidence,
      sourceTrack: 'thesis_quality',
    },
    sourceHypothesisId: descriptor.sourceHypothesisId,
    exclusionReason: 'thesis_quality_case',
  };
}
