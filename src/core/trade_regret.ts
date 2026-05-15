import type { StructuredTradeReview } from './trade_review.js';
import type { TradeCounterfactualRecord } from './trade_dossier_types.js';

export interface TradeRegretSummary {
  blockedWinnerFlag: boolean | null;
  approvedLoserFlag: boolean | null;
  resizeHelpedFlag: boolean | null;
  resizeHurtFlag: boolean | null;
  missedOpportunityFlag: boolean | null;
  regretScore: number | null;
  summary: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function buildTradeRegretSummary(params: {
  review: StructuredTradeReview;
  counterfactuals: TradeCounterfactualRecord[];
  executed: boolean;
  gateVerdict?: string | null;
  realizedPnlUsd?: number | null;
}): TradeRegretSummary {
  const noTrade = params.counterfactuals.find((row) => row.counterfactualType === 'no_trade');
  const fullSize = params.counterfactuals.find((row) => row.counterfactualType === 'full_size');
  const realizedPnlUsd = params.realizedPnlUsd ?? null;
  const blockedWinnerFlag =
    params.executed === false &&
    params.review.thesisVerdict === 'correct'
      ? true
      : params.executed === false
        ? false
        : null;
  const approvedLoserFlag =
    params.executed === true && (realizedPnlUsd ?? 0) < 0 && params.review.thesisVerdict !== 'incorrect';
  const resizeHelpedFlag =
    params.gateVerdict === 'resize' && (fullSize?.valueAddUsd ?? 0) > 0
      ? true
      : params.gateVerdict === 'resize'
        ? false
        : null;
  const resizeHurtFlag =
    params.gateVerdict === 'resize' && (fullSize?.valueAddUsd ?? 0) < 0
      ? true
      : params.gateVerdict === 'resize'
        ? false
        : null;
  const missedOpportunityFlag =
    params.executed === false && (noTrade?.valueAddUsd ?? 0) < 0 ? true : false;
  const regretScore = clamp(
    [blockedWinnerFlag, approvedLoserFlag, resizeHurtFlag, missedOpportunityFlag]
      .filter(Boolean)
      .length / 3,
    0,
    1
  );
  const labels = [
    blockedWinnerFlag ? 'blocked_winner' : null,
    approvedLoserFlag ? 'approved_loser' : null,
    resizeHelpedFlag ? 'resize_helped' : null,
    resizeHurtFlag ? 'resize_hurt' : null,
    missedOpportunityFlag ? 'missed_opportunity' : null,
  ].filter((value): value is string => Boolean(value));

  return {
    blockedWinnerFlag,
    approvedLoserFlag,
    resizeHelpedFlag,
    resizeHurtFlag,
    missedOpportunityFlag,
    regretScore,
    summary: labels.length > 0 ? labels.join(', ') : 'no_material_regret_detected',
  };
}
