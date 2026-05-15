export interface TradePolicyAdjustmentEvidence {
  setupFamily?: string | null;
  regime?: string | null;
  failureMode?: string | null;
  gateHelped?: boolean | null;
  win?: boolean | null;
  netRealizedPnlUsd?: number | null;
  sampleWeight?: number | null;
}

export interface TradePolicyAdjustmentProposal {
  policyDomain: 'size' | 'leverage' | 'confirmation' | 'cooldown' | 'confidence';
  policyKey: string;
  adjustmentType: 'set' | 'scale' | 'flag';
  oldValue: number | string | boolean | null;
  newValue: number | string | boolean | null;
  delta: number | null;
  evidenceCount: number;
  confidence: number;
  reasonSummary: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function deriveTradePolicyAdjustments(
  evidence: TradePolicyAdjustmentEvidence[]
): TradePolicyAdjustmentProposal[] {
  if (evidence.length === 0) return [];
  const weightedCount = evidence.reduce((sum, row) => sum + Math.max(0.5, row.sampleWeight ?? 1), 0);
  const losses = evidence.filter((row) => row.win === false).length;
  const wins = evidence.filter((row) => row.win === true).length;
  const gateHelpCount = evidence.filter((row) => row.gateHelped === true).length;
  const repeatedFailureMode = evidence
    .map((row) => row.failureMode?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value))
    .sort()[0] ?? null;
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0.5;
  const confidence = clamp(weightedCount / 8, 0.25, 0.95);
  const rows: TradePolicyAdjustmentProposal[] = [];

  if (weightedCount >= 3 && winRate < 0.45) {
    const sizeMultiplier = clamp(0.85 - (0.45 - winRate), 0.55, 0.85);
    rows.push({
      policyDomain: 'size',
      policyKey: 'setup_family_max_size',
      adjustmentType: 'scale',
      oldValue: 1,
      newValue: sizeMultiplier,
      delta: sizeMultiplier - 1,
      evidenceCount: evidence.length,
      confidence,
      reasonSummary: 'Recent evidence shows the setup family underperforming; reduce size.'
    });
    rows.push({
      policyDomain: 'confidence',
      policyKey: 'sparse_precedent_penalty',
      adjustmentType: 'set',
      oldValue: 0,
      newValue: clamp(0.2 + (0.45 - winRate), 0.2, 0.45),
      delta: null,
      evidenceCount: evidence.length,
      confidence,
      reasonSummary: 'Weak historical support should reduce confidence in similar trades.'
    });
  }

  if (gateHelpCount >= 2) {
    rows.push({
      policyDomain: 'confirmation',
      policyKey: 'gate_intervention_prior',
      adjustmentType: 'flag',
      oldValue: false,
      newValue: true,
      delta: null,
      evidenceCount: evidence.length,
      confidence,
      reasonSummary: 'Historical gate interventions added value and should remain active.'
    });
  }

  if (repeatedFailureMode) {
    rows.push({
      policyDomain: 'cooldown',
      policyKey: `failure_mode:${repeatedFailureMode}`,
      adjustmentType: 'flag',
      oldValue: false,
      newValue: true,
      delta: null,
      evidenceCount: evidence.length,
      confidence: clamp(confidence - 0.1, 0.2, 0.95),
      reasonSummary: 'Repeated failure mode detected; apply a cooldown until new evidence arrives.'
    });
  }

  return rows;
}
