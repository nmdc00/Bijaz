import type { ExecutionLearningCase } from './execution_learning.js';
import type { TradeDossier } from '../memory/trade_dossiers.js';
import type { UpsertTradeSimilarityFeaturesInput } from '../memory/trade_similarity_features.js';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function canonicalizeCategory(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : null;
}

function countFirstArray(value: Record<string, unknown> | null, keys: string[]): number | null {
  if (!value) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.length;
    }
  }
  return null;
}

function inferCatalystFreshnessBucket(
  noveltyScore: number | null
): UpsertTradeSimilarityFeaturesInput['catalystFreshnessBucket'] {
  if (noveltyScore == null) return null;
  if (noveltyScore >= 0.75) return 'fresh';
  if (noveltyScore >= 0.4) return 'aging';
  return 'stale';
}

function inferEntryExtensionBucket(entryStretchPct: number | null): string | null {
  if (entryStretchPct == null) return null;
  if (entryStretchPct <= 1.5) return 'tight';
  if (entryStretchPct <= 4) return 'extended';
  return 'chasing';
}

function inferExecutionConditionBucket(params: {
  volatilityBucket: string | null;
  liquidityBucket: string | null;
  gateVerdict: string | null;
}): string | null {
  if (params.gateVerdict === 'reject') return 'rejected';
  if (params.liquidityBucket === 'thin' && params.volatilityBucket === 'high') return 'fragile';
  if (params.liquidityBucket === 'deep' && (params.volatilityBucket === 'low' || params.volatilityBucket === 'medium')) {
    return 'stable';
  }
  if (params.volatilityBucket === 'high') return 'high_volatility';
  if (params.liquidityBucket === 'thin') return 'thin_liquidity';
  return null;
}

function inferSessionBucket(timestamp: string | number | null): string | null {
  const parsedMs =
    typeof timestamp === 'number'
      ? timestamp
      : typeof timestamp === 'string'
        ? Date.parse(timestamp)
        : Number.NaN;
  if (!Number.isFinite(parsedMs)) return null;
  const hour = new Date(parsedMs).getUTCHours();
  if (hour < 6) return 'asia';
  if (hour < 13) return 'europe';
  if (hour < 18) return 'us_open';
  return 'us_late';
}

function inferThesisVerdict(review: Record<string, unknown>, learningCase: ExecutionLearningCase | null): string | null {
  const explicit = canonicalizeCategory(readString(review.thesisVerdict));
  if (explicit) return explicit;
  const thesisCorrect = learningCase?.outcome?.thesisCorrect;
  if (thesisCorrect === true) return 'correct';
  if (thesisCorrect === false) return 'incorrect';
  return null;
}

function inferSuccessDriver(params: {
  review: Record<string, unknown>;
  thesisVerdict: string | null;
  exitMode: string | null;
  gateVerdict: string | null;
}): string | null {
  const explicit = canonicalizeCategory(readString(params.review.mainSuccessDriver));
  if (explicit) return explicit;
  if (params.gateVerdict === 'resize') return 'gate_intervention_preserved_edge';
  if (params.exitMode === 'take_profit') return 'disciplined_exit_management';
  if (params.thesisVerdict === 'correct') return 'thesis_directionality_held';
  return null;
}

function inferFailureMode(params: {
  review: Record<string, unknown>;
  thesisVerdict: string | null;
  entryQuality: string | null;
  exitMode: string | null;
}): string | null {
  const explicit = canonicalizeCategory(readString(params.review.mainFailureMode));
  if (explicit) return explicit;
  if (params.entryQuality === 'poor' || params.entryQuality === 'weak') return 'late_or_stretched_entry';
  if (params.exitMode === 'manual' || params.exitMode === 'unknown') return 'discretionary_exit';
  if (params.thesisVerdict === 'incorrect') return 'directional_thesis_failed';
  return null;
}

export function deriveTradeSimilarityFeatures(params: {
  dossier: TradeDossier;
  learningCase?: ExecutionLearningCase | null;
}): UpsertTradeSimilarityFeaturesInput {
  const dossierPayload = readRecord(params.dossier.dossier) ?? {};
  const review = readRecord(params.dossier.review) ?? {};
  const context = readRecord(dossierPayload.context) ?? {};
  const gate = readRecord(dossierPayload.gate) ?? {};
  const close = readRecord(dossierPayload.close) ?? {};
  const retrieval = readRecord(params.dossier.retrieval) ?? {};
  const learningContext = readRecord(params.learningCase?.context) ?? {};
  const learningPolicyInputs = readRecord(params.learningCase?.policyInputs) ?? {};
  const learningPlanContext = readRecord(learningPolicyInputs.planContext) ?? {};
  const learningSnapshot = readRecord(params.learningCase?.sourceLinks?.snapshot) ?? {};

  const signalClass =
    canonicalizeCategory(readString(context.signalClass)) ??
    canonicalizeCategory(readString(learningContext.signalClass));
  const tradeArchetype =
    canonicalizeCategory(readString(context.tradeArchetype)) ??
    canonicalizeCategory(readString(learningContext.tradeArchetype));
  const marketRegime =
    canonicalizeCategory(readString(context.marketRegime)) ??
    canonicalizeCategory(readString(learningContext.marketRegime));
  const volatilityBucket =
    canonicalizeCategory(readString(context.volatilityBucket)) ??
    canonicalizeCategory(readString(learningContext.volatilityBucket));
  const liquidityBucket =
    canonicalizeCategory(readString(context.liquidityBucket)) ??
    canonicalizeCategory(readString(learningContext.liquidityBucket));
  const entryTrigger =
    canonicalizeCategory(readString(context.entryTrigger)) ??
    canonicalizeCategory(readString(learningContext.entryTrigger));
  const gateVerdict =
    canonicalizeCategory(readString(gate.verdict)) ??
    canonicalizeCategory(readString(learningPolicyInputs.gateVerdict)) ??
    canonicalizeCategory(readString(learningPlanContext.gateVerdict));
  const thesisVerdict = inferThesisVerdict(review, params.learningCase ?? null);
  const entryQuality = canonicalizeCategory(readString(review.entryQuality));
  const sizingQuality = canonicalizeCategory(readString(review.sizingQuality));
  const exitMode =
    canonicalizeCategory(readString(close.exitMode)) ??
    canonicalizeCategory(readString(params.learningCase?.outcome?.exitMode));
  const sourceCount =
    readNumber(retrieval.sourceCount) ??
    countFirstArray(retrieval, ['retrievedCases', 'topMatches', 'matches', 'results']);
  const conflictingEvidenceCount =
    readNumber(retrieval.conflictingEvidenceCount) ??
    countFirstArray(retrieval, ['retrievalRiskFlags', 'riskFlags']);
  const noveltyScore =
    readNumber(learningSnapshot.noveltyScore) ??
    readNumber(learningPlanContext.noveltyScore) ??
    readNumber(context.noveltyScore);
  const entryStretchPct =
    readNumber(learningSnapshot.entryStretchPct) ??
    readNumber(learningPlanContext.entryStretchPct) ??
    readNumber(context.entryStretchPct);

  return {
    dossierId: params.dossier.id,
    symbol: params.dossier.symbol,
    signalClass,
    tradeArchetype,
    marketRegime,
    volatilityBucket,
    liquidityBucket,
    entryTrigger,
    newsSubtype:
      canonicalizeCategory(readString(context.newsSubtype)) ??
      canonicalizeCategory(readString(learningSnapshot.newsSubtype)),
    proxyExpression:
      canonicalizeCategory(readString(context.proxyExpression)) ??
      canonicalizeCategory(readString(learningPlanContext.proxyExpression)),
    catalystFreshnessBucket: inferCatalystFreshnessBucket(noveltyScore),
    entryExtensionBucket: inferEntryExtensionBucket(entryStretchPct),
    portfolioOverlapBucket:
      canonicalizeCategory(readString(context.portfolioOverlapBucket)) ??
      canonicalizeCategory(readString(learningPlanContext.portfolioOverlapBucket)),
    gateVerdict,
    failureMode: inferFailureMode({
      review,
      thesisVerdict,
      entryQuality,
      exitMode,
    }),
    successDriver: inferSuccessDriver({
      review,
      thesisVerdict,
      exitMode,
      gateVerdict,
    }),
    thesisVerdict,
    entryQuality,
    sizingQuality,
    opportunityRank:
      readNumber(learningPlanContext.opportunityRank) ??
      readNumber(context.opportunityRank),
    sourceCount,
    conflictingEvidenceCount,
    executionConditionBucket: inferExecutionConditionBucket({
      volatilityBucket,
      liquidityBucket,
      gateVerdict,
    }),
    sessionBucket:
      canonicalizeCategory(readString(context.sessionBucket)) ??
      inferSessionBucket(params.dossier.openedAt ?? params.learningCase?.createdAtMs ?? null),
    regimeTransitionFlag:
      readBoolean(context.regimeTransitionFlag) ??
      readBoolean(learningPlanContext.regimeTransitionFlag) ??
      Boolean(marketRegime?.includes('transition')),
  };
}
