import type { LearningCase } from '../memory/learning_cases.js';
import { listLearningCases } from '../memory/learning_cases.js';
import type { TradeDossier } from '../memory/trade_dossiers.js';
import { listTradeDossiers } from '../memory/trade_dossiers.js';
import {
  buildStructuredTradeReviewSnapshot,
  type StructuredTradeReview,
} from './trade_review.js';

export interface TradeSimilarityQuery {
  symbol: string;
  direction?: 'long' | 'short' | null;
  strategySource?: string | null;
  triggerReason?: string | null;
  signalClass?: string | null;
  regime?: string | null;
  gateVerdict?: string | null;
  entryStretchPct?: number | null;
  symbolClass?: string | null;
  limit?: number;
  maxCandidates?: number;
}

export interface TradeSimilarityStats {
  sampleSize: number;
  winRate: number | null;
  averageRealizedPnlUsd: number | null;
  averageEntryStretchPct: number | null;
  averageInterventionScore: number | null;
  gateVerdictCounts: Record<string, number>;
}

export interface TradeSimilarityMatch {
  dossierId: string;
  symbol: string;
  direction: 'long' | 'short' | null;
  triggerReason: string | null;
  similarityScore: number;
  matchedOn: string[];
  symbolClass: string | null;
  signalClass: string | null;
  regime: string | null;
  gateVerdict: string | null;
  entryStretchPct: number | null;
  realizedPnlUsd: number | null;
  interventionScore: number | null;
  thesisVerdict: StructuredTradeReview['thesisVerdict'];
  review: StructuredTradeReview;
}

export interface TradeSimilaritySummary {
  recommendation: 'approval' | 'caution' | 'size_reduction';
  retrievalSupportScore: number;
  retrievalConfidence: number;
  retrievalRiskFlags: string[];
  stats: TradeSimilarityStats;
  topLessons: string[];
  repeatTags: string[];
  avoidTags: string[];
  topMatches: TradeSimilarityMatch[];
}

interface TradeFeatureVector {
  symbolClass: string | null;
  signalClass: string | null;
  regime: string | null;
  gateVerdict: string | null;
  entryStretchPct: number | null;
  triggerReason: string | null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeText(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() ?? null;
}

export function inferTradeSymbolClass(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (normalized.startsWith('XYZ:')) {
    return normalized.endsWith('COIN') || normalized.endsWith('MSTR') ? 'equity_proxy' : 'macro_contract';
  }
  if (normalized.startsWith('FLX:')) return 'alt_perp';
  if (normalized.includes('/')) return 'spot_pair';
  return 'crypto';
}

function getDossierContext(dossier: TradeDossier): Record<string, unknown> {
  return readRecord(readRecord(dossier.dossier)?.context) ?? {};
}

function getDossierGate(dossier: TradeDossier): Record<string, unknown> {
  return readRecord(readRecord(dossier.dossier)?.gate) ?? {};
}

function getDossierClose(dossier: TradeDossier): Record<string, unknown> {
  return readRecord(readRecord(dossier.dossier)?.close) ?? {};
}

function getDossierCounterfactuals(dossier: TradeDossier): Record<string, unknown> {
  return readRecord(readRecord(dossier.dossier)?.counterfactuals) ?? {};
}

function extractCaseContext(cases: LearningCase[]): Record<string, unknown> {
  for (const learningCase of cases) {
    const context = readRecord(learningCase.context);
    if (context) return context;
  }
  return {};
}

function extractFeatureVector(
  dossier: TradeDossier,
  learningCases: LearningCase[]
): TradeFeatureVector {
  const context = getDossierContext(dossier);
  const learningContext = extractCaseContext(learningCases);
  const gate = getDossierGate(dossier);
  const execution = readRecord(readRecord(dossier.dossier)?.execution) ?? {};

  return {
    symbolClass:
      normalizeText(
          readString(context.symbolClass) ??
          readString(learningContext.symbolClass) ??
          inferTradeSymbolClass(dossier.symbol)
      ) ?? inferTradeSymbolClass(dossier.symbol),
    signalClass: normalizeText(
      readString(context.signalClass) ?? readString(learningContext.signalClass)
    ),
    regime: normalizeText(
      readString(context.regime) ??
        readString(context.marketRegime) ??
        readString(learningContext.regime) ??
        readString(learningContext.marketRegime)
    ),
    gateVerdict: normalizeText(
      readString(gate.verdict) ??
        readString(learningContext.gateVerdict) ??
        readString(learningContext.entryGateVerdict)
    ),
    entryStretchPct:
      readNumber(context.entryStretchPct) ??
      readNumber(execution.entryStretchPct) ??
      readNumber(gate.entryStretchPct) ??
      readNumber(learningContext.entryStretchPct),
    triggerReason: normalizeText(dossier.triggerReason),
  };
}

function buildMatch(
  query: TradeSimilarityQuery,
  dossier: TradeDossier,
  learningCases: LearningCase[]
): TradeSimilarityMatch {
  const features = extractFeatureVector(dossier, learningCases);
  const review = buildStructuredTradeReviewSnapshot(dossier, learningCases);
  const querySymbolClass = normalizeText(query.symbolClass ?? inferTradeSymbolClass(query.symbol));
  const querySignalClass = normalizeText(query.signalClass);
  const queryRegime = normalizeText(query.regime);
  const queryGateVerdict = normalizeText(query.gateVerdict);
  const queryTriggerReason = normalizeText(query.triggerReason);
  const queryDirection = query.direction ?? null;
  const queryStrategySource = normalizeText(query.strategySource);

  let score = 0;
  const matchedOn: string[] = [];

  if (querySymbolClass && features.symbolClass === querySymbolClass) {
    score += 30;
    matchedOn.push('symbol_class');
  }
  if (querySignalClass && features.signalClass === querySignalClass) {
    score += 24;
    matchedOn.push('signal_class');
  }
  if (queryTriggerReason && features.triggerReason === queryTriggerReason) {
    score += 16;
    matchedOn.push('trigger_reason');
  }
  if (queryRegime && features.regime === queryRegime) {
    score += 12;
    matchedOn.push('regime');
  }
  if (queryGateVerdict && features.gateVerdict === queryGateVerdict) {
    score += 8;
    matchedOn.push('gate_verdict');
  }
  if (
    query.entryStretchPct != null &&
    features.entryStretchPct != null
  ) {
    const distance = Math.abs(query.entryStretchPct - features.entryStretchPct);
    const stretchScore = Math.max(0, 10 - Math.min(10, distance));
    if (stretchScore > 0) {
      score += stretchScore;
      matchedOn.push('entry_stretch');
    }
  }
  if (queryDirection && dossier.direction === queryDirection) {
    score += 4;
    matchedOn.push('direction');
  }
  if (
    queryStrategySource &&
    normalizeText(dossier.strategySource) === queryStrategySource
  ) {
    score += 4;
    matchedOn.push('strategy_source');
  }

  const close = getDossierClose(dossier);
  const counterfactuals = getDossierCounterfactuals(dossier);

  return {
    dossierId: dossier.id,
    symbol: dossier.symbol,
    direction: dossier.direction,
    triggerReason: dossier.triggerReason,
    similarityScore: score,
    matchedOn,
    symbolClass: features.symbolClass,
    signalClass: features.signalClass,
    regime: features.regime,
    gateVerdict: features.gateVerdict,
    entryStretchPct: features.entryStretchPct,
    realizedPnlUsd: readNumber(close.netRealizedPnlUsd),
    interventionScore:
      readNumber(counterfactuals.interventionScore) ??
      readNumber(counterfactuals.valueAddScore),
    thesisVerdict: review.thesisVerdict,
    review,
  };
}

function incrementCounter(map: Record<string, number>, value: string | null): void {
  if (!value) return;
  map[value] = (map[value] ?? 0) + 1;
}

function summarizeStats(matches: TradeSimilarityMatch[]): TradeSimilarityStats {
  const gateVerdictCounts: Record<string, number> = {};
  const pnlRows = matches
    .map((row) => row.realizedPnlUsd)
    .filter((value): value is number => value != null);
  const stretchRows = matches
    .map((row) => row.entryStretchPct)
    .filter((value): value is number => value != null);
  const interventionRows = matches
    .map((row) => row.interventionScore)
    .filter((value): value is number => value != null);

  for (const match of matches) {
    incrementCounter(gateVerdictCounts, match.gateVerdict);
  }

  return {
    sampleSize: matches.length,
    winRate:
      pnlRows.length > 0
        ? pnlRows.filter((value) => value > 0).length / pnlRows.length
        : null,
    averageRealizedPnlUsd:
      pnlRows.length > 0
        ? pnlRows.reduce((sum, value) => sum + value, 0) / pnlRows.length
        : null,
    averageEntryStretchPct:
      stretchRows.length > 0
        ? stretchRows.reduce((sum, value) => sum + value, 0) / stretchRows.length
        : null,
    averageInterventionScore:
      interventionRows.length > 0
        ? interventionRows.reduce((sum, value) => sum + value, 0) / interventionRows.length
        : null,
    gateVerdictCounts,
  };
}

function topCounts(values: string[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function chooseRecommendation(
  stats: TradeSimilarityStats,
  repeatTags: string[],
  avoidTags: string[]
): TradeSimilaritySummary['recommendation'] {
  const resizeLikeCount =
    (stats.gateVerdictCounts.resize ?? 0) + (stats.gateVerdictCounts.reject ?? 0);
  if (
    resizeLikeCount >= Math.ceil(Math.max(1, stats.sampleSize) / 2) ||
    avoidTags.length > repeatTags.length
  ) {
    return 'size_reduction';
  }
  if ((stats.winRate ?? 0) < 0.45 || avoidTags.length > 0) {
    return 'caution';
  }
  return 'approval';
}

function deriveRetrievalSupportScore(
  stats: TradeSimilarityStats,
  repeatTags: string[],
  avoidTags: string[]
): number {
  const winRate = stats.winRate ?? 0.5;
  const intervention = stats.averageInterventionScore ?? 0;
  const sampleFactor = Math.min(1, stats.sampleSize / 5);
  const tagBias = Math.max(-0.25, Math.min(0.25, (repeatTags.length - avoidTags.length) * 0.05));
  return Math.max(0, Math.min(1, winRate * 0.45 + sampleFactor * 0.25 + ((intervention + 1) / 2) * 0.2 + 0.1 + tagBias));
}

function deriveRetrievalRiskFlags(
  stats: TradeSimilarityStats,
  repeatTags: string[],
  avoidTags: string[]
): string[] {
  const flags = new Set<string>();
  if (stats.sampleSize < 2) flags.add('sparse_precedent');
  if ((stats.winRate ?? 0.5) < 0.45) flags.add('weak_historical_win_rate');
  if ((stats.averageInterventionScore ?? 0) < -0.1) flags.add('intervention_history_negative');
  if (avoidTags.length > repeatTags.length) flags.add('avoid_tags_outnumber_repeat_tags');
  if ((stats.averageEntryStretchPct ?? 0) > 6) flags.add('late_entry_cluster');
  return [...flags];
}

export function summarizeTradeSimilarity(matches: TradeSimilarityMatch[]): TradeSimilaritySummary {
  const stats = summarizeStats(matches);
  const topLessons = topCounts(matches.flatMap((row) => row.review.lessons), 5);
  const repeatTags = topCounts(matches.flatMap((row) => row.review.repeatTags), 5);
  const avoidTags = topCounts(matches.flatMap((row) => row.review.avoidTags), 5);
  const retrievalRiskFlags = deriveRetrievalRiskFlags(stats, repeatTags, avoidTags);
  const retrievalSupportScore = deriveRetrievalSupportScore(stats, repeatTags, avoidTags);
  const retrievalConfidence = Math.max(
    0,
    Math.min(1, Math.min(1, stats.sampleSize / 4) * 0.7 + (matches[0]?.review.reviewConfidence ?? 0.4) * 0.3)
  );
  return {
    recommendation: chooseRecommendation(stats, repeatTags, avoidTags),
    retrievalSupportScore,
    retrievalConfidence,
    retrievalRiskFlags,
    stats,
    topLessons,
    repeatTags,
    avoidTags,
    topMatches: matches.slice(0, 5),
  };
}

export function retrieveSimilarTradeDossiers(
  query: TradeSimilarityQuery,
  options: {
    dossiers?: TradeDossier[];
    learningCasesByDossierId?: Record<string, LearningCase[]>;
  } = {}
): TradeSimilaritySummary {
  const dossiers =
    options.dossiers ??
    listTradeDossiers({
      status: 'closed',
      limit: query.maxCandidates ?? 250,
    });

  const matches = dossiers
    .filter((dossier) => dossier.symbol !== query.symbol.trim().toUpperCase() || dossier.status === 'closed')
    .map((dossier) =>
      buildMatch(
        query,
        dossier,
        options.learningCasesByDossierId?.[dossier.id] ??
          listLearningCases({ sourceDossierId: dossier.id, limit: 20 })
      )
    )
    .filter((match) => match.similarityScore > 0)
    .sort((a, b) => b.similarityScore - a.similarityScore || b.dossierId.localeCompare(a.dossierId))
    .slice(0, query.limit ?? 5);

  return summarizeTradeSimilarity(matches);
}
