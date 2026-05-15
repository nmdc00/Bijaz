export type TradeReviewBand = 'strong' | 'adequate' | 'weak' | 'poor' | 'unknown';
export type TradeThesisVerdict = 'correct' | 'mixed' | 'incorrect' | 'unclear';
export type TradeCounterfactualType =
  | 'no_trade'
  | 'full_size'
  | 'approved_size'
  | 'delay_entry'
  | 'invalidation_exit'
  | 'ttl_exit'
  | 'alternate_expression'
  | 'leverage_cap';

export interface TradeDossierPathSection {
  maxFavorableExcursionPct?: number | null;
  maxAdverseExcursionPct?: number | null;
  timeToFirstConfirmationMs?: number | null;
  timeSpentUnderwaterMs?: number | null;
  timeToInvalidationMs?: number | null;
  thesisWorkedLaterAfterStopout?: boolean | null;
  betterTimedEntryAvailableLater?: boolean | null;
  pathShapeMatchedHistory?: boolean | null;
}

export interface TradeDossierReviewSection {
  thesisVerdict?: TradeThesisVerdict | null;
  entryQuality?: TradeReviewBand | null;
  sizingQuality?: TradeReviewBand | null;
  leverageQuality?: TradeReviewBand | null;
  exitQuality?: TradeReviewBand | null;
  gateInterventionQuality?: TradeReviewBand | null;
  contextFit?: TradeReviewBand | null;
  reviewConfidence?: number | null;
  counterfactualNeeded?: boolean | null;
  mainSuccessDriver?: string | null;
  mainFailureMode?: string | null;
  lessons?: string[] | null;
  repeatTags?: string[] | null;
  avoidTags?: string[] | null;
}

export interface TradeCounterfactualRecord {
  counterfactualType: TradeCounterfactualType;
  baselineKind: 'counterfactual' | 'approved_trade' | 'policy_intervention';
  summary: string;
  score: number | null;
  estimatedNetPnlUsd: number | null;
  estimatedRMultiple: number | null;
  valueAddUsd: number | null;
  confidence: number | null;
  inputsPayload?: Record<string, unknown> | null;
  resultPayload?: Record<string, unknown> | null;
}

export interface AdaptiveRetrievalSummary {
  recommendation: 'approval' | 'caution' | 'size_reduction';
  retrievalSupportScore: number;
  retrievalConfidence: number;
  retrievalRiskFlags: string[];
}

export interface AdaptivePolicyTrace {
  activePolicies: string[];
  activeAdjustmentIds: string[];
  sizeHaircuts: number[];
  leverageCaps: number[];
  confirmationRequirements: string[];
  confidencePenalties: number[];
  triggeredCooldowns: string[];
  preAdjustmentSize: number | null;
  postAdjustmentSize: number | null;
  preAdjustmentLeverage: number | null;
  postAdjustmentLeverage: number | null;
  retrievalChangedVerdict: boolean;
  adaptationChangedOutcome: boolean;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function getDossierSection(
  dossier: Record<string, unknown> | null | undefined,
  key: string
): Record<string, unknown> | null {
  return readRecord(readRecord(dossier)?.[key]);
}
