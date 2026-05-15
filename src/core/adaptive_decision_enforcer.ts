import type { AdaptivePolicyTrace, AdaptiveRetrievalSummary } from './trade_dossier_types.js';
import type { TradePolicyAdjustmentProposal } from './trade_policy_adaptation.js';

export interface AdaptiveDecisionRequest {
  requestedNotionalUsd: number;
  requestedLeverage: number | null;
  retrieval: AdaptiveRetrievalSummary;
  policyAdjustments: TradePolicyAdjustmentProposal[];
}

export interface AdaptiveDecisionResult {
  verdict: 'approve' | 'resize' | 'reject';
  approvedNotionalUsd: number;
  approvedLeverage: number | null;
  reasonCodes: string[];
  policyTrace: AdaptivePolicyTrace;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function applyAdaptiveDecisionEnforcement(
  request: AdaptiveDecisionRequest
): AdaptiveDecisionResult {
  let approvedNotionalUsd = request.requestedNotionalUsd;
  let approvedLeverage = request.requestedLeverage;
  const sizeHaircuts: number[] = [];
  const leverageCaps: number[] = [];
  const confirmationRequirements: string[] = [];
  const confidencePenalties: number[] = [];
  const triggeredCooldowns: string[] = [];
  const reasonCodes = [...request.retrieval.retrievalRiskFlags];

  if (request.retrieval.recommendation === 'size_reduction') {
    approvedNotionalUsd = approvedNotionalUsd * 0.7;
    sizeHaircuts.push(0.3);
    reasonCodes.push('retrieval:size_reduction');
  }
  if (request.retrieval.retrievalConfidence < 0.35) {
    approvedNotionalUsd = approvedNotionalUsd * 0.8;
    confidencePenalties.push(0.2);
    reasonCodes.push('retrieval:low_confidence');
  }

  for (const adjustment of request.policyAdjustments) {
    if (adjustment.policyDomain === 'size' && typeof adjustment.newValue === 'number') {
      approvedNotionalUsd = approvedNotionalUsd * adjustment.newValue;
      sizeHaircuts.push(clamp(1 - adjustment.newValue, 0, 0.8));
    } else if (adjustment.policyDomain === 'leverage' && typeof adjustment.newValue === 'number') {
      approvedLeverage =
        approvedLeverage == null ? adjustment.newValue : Math.min(approvedLeverage, adjustment.newValue);
      leverageCaps.push(adjustment.newValue);
    } else if (adjustment.policyDomain === 'confirmation') {
      confirmationRequirements.push(adjustment.policyKey);
    } else if (adjustment.policyDomain === 'cooldown') {
      triggeredCooldowns.push(adjustment.policyKey);
    } else if (adjustment.policyDomain === 'confidence' && typeof adjustment.newValue === 'number') {
      confidencePenalties.push(adjustment.newValue);
    }
  }

  const verdict =
    triggeredCooldowns.length > 0 || approvedNotionalUsd < request.requestedNotionalUsd * 0.2
      ? 'reject'
      : approvedNotionalUsd < request.requestedNotionalUsd || leverageCaps.length > 0
        ? 'resize'
        : 'approve';

  return {
    verdict,
    approvedNotionalUsd: clamp(approvedNotionalUsd, 0, request.requestedNotionalUsd),
    approvedLeverage,
    reasonCodes: [...new Set(reasonCodes)],
    policyTrace: {
      activePolicies: [
        'retrieval_similarity',
        ...request.policyAdjustments.map((row) => `${row.policyDomain}:${row.policyKey}`),
      ],
      activeAdjustmentIds: request.policyAdjustments.map((row) => `${row.policyDomain}:${row.policyKey}`),
      sizeHaircuts,
      leverageCaps,
      confirmationRequirements,
      confidencePenalties,
      triggeredCooldowns,
      preAdjustmentSize: request.requestedNotionalUsd,
      postAdjustmentSize: clamp(approvedNotionalUsd, 0, request.requestedNotionalUsd),
      preAdjustmentLeverage: request.requestedLeverage,
      postAdjustmentLeverage: approvedLeverage,
      retrievalChangedVerdict: request.retrieval.recommendation === 'size_reduction',
      adaptationChangedOutcome: verdict !== 'approve',
    },
  };
}
