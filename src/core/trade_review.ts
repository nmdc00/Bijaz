import type { LearningCase } from '../memory/learning_cases.js';
import type { TradeDossier } from '../memory/trade_dossiers.js';

export type TradeReviewBand = 'strong' | 'adequate' | 'weak' | 'poor' | 'unknown';
export type TradeThesisVerdict = 'correct' | 'mixed' | 'incorrect' | 'unclear';

export interface StructuredTradeReview {
  thesisVerdict: TradeThesisVerdict;
  entryQuality: TradeReviewBand;
  sizingQuality: TradeReviewBand;
  leverageQuality: TradeReviewBand;
  exitQuality: TradeReviewBand;
  gateInterventionQuality: TradeReviewBand;
  contextFit: TradeReviewBand;
  reviewConfidence: number;
  counterfactualNeeded: boolean;
  mainSuccessDriver: string | null;
  mainFailureMode: string | null;
  lessons: string[];
  repeatTags: string[];
  avoidTags: string[];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    rows.push(normalized);
  }
  return rows;
}

function normalizeBand(value: unknown): TradeReviewBand {
  const normalized = readString(value)?.toLowerCase();
  if (
    normalized === 'strong' ||
    normalized === 'adequate' ||
    normalized === 'weak' ||
    normalized === 'poor'
  ) {
    return normalized;
  }
  return 'unknown';
}

function normalizeThesisVerdict(value: unknown): TradeThesisVerdict {
  const normalized = readString(value)?.toLowerCase();
  if (
    normalized === 'correct' ||
    normalized === 'mixed' ||
    normalized === 'incorrect' ||
    normalized === 'unclear'
  ) {
    return normalized;
  }
  return 'unclear';
}

function firstPopulatedString(
  ...values: Array<unknown>
): string | null {
  for (const value of values) {
    const normalized = readString(value);
    if (normalized) return normalized;
  }
  return null;
}

function firstPopulatedStringArray(...values: Array<unknown>): string[] {
  for (const value of values) {
    const normalized = readStringArray(value);
    if (normalized.length > 0) return normalized;
  }
  return [];
}

function buildDerivedLessons(review: StructuredTradeReview): string[] {
  const lessons = [...review.lessons];
  if (review.entryQuality === 'weak' || review.entryQuality === 'poor') {
    lessons.push('Entry timing was the weak point; treat similar setups as lower-conviction.');
  }
  if (review.gateInterventionQuality === 'strong') {
    lessons.push('Gate intervention helped and should influence similar future sizing decisions.');
  }
  if (review.thesisVerdict === 'correct' && review.exitQuality === 'poor') {
    lessons.push('Separate thesis correctness from trade management quality in future reviews.');
  }
  return [...new Set(lessons)];
}

function deriveReviewConfidence(
  reviewRecord: Record<string, unknown>,
  learningCases: LearningCase[]
): number {
  let score = 0.2;
  if (Object.keys(reviewRecord).length > 0) score += 0.35;
  if (learningCases.some((row) => row.caseType === 'execution_quality')) score += 0.25;
  if (learningCases.some((row) => row.caseType === 'thesis_quality')) score += 0.2;
  return Math.max(0, Math.min(1, score));
}

export function normalizeStructuredTradeReview(
  reviewPayload: Record<string, unknown> | null,
  learningCases: LearningCase[] = []
): StructuredTradeReview {
  const executionCase = learningCases.find((row) => row.caseType === 'execution_quality');
  const thesisCase = learningCases.find((row) => row.caseType === 'thesis_quality');

  const reviewRecord = readRecord(reviewPayload) ?? {};
  const review = {
    thesisVerdict: normalizeThesisVerdict(
      firstPopulatedString(
        reviewRecord.thesisVerdict,
        thesisCase?.outcome ? readRecord(thesisCase.outcome)?.thesisVerdict : null,
        executionCase?.outcome ? readRecord(executionCase.outcome)?.thesisVerdict : null
      )
    ),
    entryQuality: normalizeBand(
      firstPopulatedString(
        reviewRecord.entryQuality,
        executionCase?.qualityScores ? readRecord(executionCase.qualityScores)?.entryQuality : null
      )
    ),
    sizingQuality: normalizeBand(
      firstPopulatedString(
        reviewRecord.sizingQuality,
        executionCase?.qualityScores ? readRecord(executionCase.qualityScores)?.sizingQuality : null
      )
    ),
    leverageQuality: normalizeBand(
      firstPopulatedString(
        reviewRecord.leverageQuality,
        executionCase?.qualityScores
          ? readRecord(executionCase.qualityScores)?.leverageQuality
          : null
      )
    ),
    exitQuality: normalizeBand(
      firstPopulatedString(
        reviewRecord.exitQuality,
        executionCase?.qualityScores ? readRecord(executionCase.qualityScores)?.exitQuality : null
      )
    ),
    gateInterventionQuality: normalizeBand(
      firstPopulatedString(
        reviewRecord.gateInterventionQuality,
        executionCase?.qualityScores
          ? readRecord(executionCase.qualityScores)?.gateInterventionQuality
          : null
      )
    ),
    contextFit: normalizeBand(
      firstPopulatedString(
        reviewRecord.contextFit,
        executionCase?.qualityScores ? readRecord(executionCase.qualityScores)?.contextFit : null
      )
    ),
    reviewConfidence:
      typeof reviewRecord.reviewConfidence === 'number'
        ? Math.max(0, Math.min(1, reviewRecord.reviewConfidence))
        : deriveReviewConfidence(reviewRecord, learningCases),
    counterfactualNeeded:
      readBoolean(reviewRecord.counterfactualNeeded) ??
      (firstPopulatedString(reviewRecord.gateInterventionQuality) == null &&
      firstPopulatedString(reviewRecord.mainFailureMode)?.toLowerCase().includes('gate')
        ? true
        : false),
    mainSuccessDriver: firstPopulatedString(reviewRecord.mainSuccessDriver),
    mainFailureMode: firstPopulatedString(reviewRecord.mainFailureMode),
    lessons: firstPopulatedStringArray(reviewRecord.lessons),
    repeatTags: firstPopulatedStringArray(reviewRecord.repeatTags),
    avoidTags: firstPopulatedStringArray(reviewRecord.avoidTags),
  } satisfies StructuredTradeReview;

  return {
    ...review,
    lessons: buildDerivedLessons(review),
  };
}

export function buildStructuredTradeReviewSnapshot(
  dossier: TradeDossier,
  learningCases: LearningCase[] = []
): StructuredTradeReview {
  return normalizeStructuredTradeReview(dossier.review, learningCases);
}
