import { openDatabase } from './db.js';

export interface TradeSimilarityFeatures {
  dossierId: string;
  symbol: string;
  signalClass: string | null;
  tradeArchetype: string | null;
  marketRegime: string | null;
  volatilityBucket: string | null;
  liquidityBucket: string | null;
  entryTrigger: string | null;
  newsSubtype: string | null;
  proxyExpression: string | null;
  catalystFreshnessBucket: string | null;
  entryExtensionBucket: string | null;
  portfolioOverlapBucket: string | null;
  gateVerdict: string | null;
  failureMode: string | null;
  successDriver: string | null;
  thesisVerdict: string | null;
  entryQuality: string | null;
  sizingQuality: string | null;
  opportunityRank: number | null;
  sourceCount: number | null;
  conflictingEvidenceCount: number | null;
  executionConditionBucket: string | null;
  sessionBucket: string | null;
  regimeTransitionFlag: boolean;
  createdAt: string;
}

export interface UpsertTradeSimilarityFeaturesInput {
  dossierId: string;
  symbol: string;
  signalClass?: string | null;
  tradeArchetype?: string | null;
  marketRegime?: string | null;
  volatilityBucket?: string | null;
  liquidityBucket?: string | null;
  entryTrigger?: string | null;
  newsSubtype?: string | null;
  proxyExpression?: string | null;
  catalystFreshnessBucket?: string | null;
  entryExtensionBucket?: string | null;
  portfolioOverlapBucket?: string | null;
  gateVerdict?: string | null;
  failureMode?: string | null;
  successDriver?: string | null;
  thesisVerdict?: string | null;
  entryQuality?: string | null;
  sizingQuality?: string | null;
  opportunityRank?: number | null;
  sourceCount?: number | null;
  conflictingEvidenceCount?: number | null;
  executionConditionBucket?: string | null;
  sessionBucket?: string | null;
  regimeTransitionFlag?: boolean;
}

export interface ListTradeSimilarityFeaturesFilters {
  symbol?: string;
  signalClass?: string;
  tradeArchetype?: string;
  marketRegime?: string;
  gateVerdict?: string;
  limit?: number;
}

function ensureTradeSimilarityFeaturesSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_similarity_features (
      dossier_id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      signal_class TEXT,
      trade_archetype TEXT,
      market_regime TEXT,
      volatility_bucket TEXT,
      liquidity_bucket TEXT,
      entry_trigger TEXT,
      news_subtype TEXT,
      proxy_expression TEXT,
      catalyst_freshness_bucket TEXT,
      entry_extension_bucket TEXT,
      portfolio_overlap_bucket TEXT,
      gate_verdict TEXT,
      failure_mode TEXT,
      success_driver TEXT,
      thesis_verdict TEXT,
      entry_quality TEXT,
      sizing_quality TEXT,
      opportunity_rank REAL,
      source_count INTEGER,
      conflicting_evidence_count INTEGER,
      execution_condition_bucket TEXT,
      session_bucket TEXT,
      regime_transition_flag INTEGER NOT NULL DEFAULT 0 CHECK(regime_transition_flag IN (0, 1)),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trade_similarity_features_symbol ON trade_similarity_features(symbol);
    CREATE INDEX IF NOT EXISTS idx_trade_similarity_features_signal_class ON trade_similarity_features(signal_class);
    CREATE INDEX IF NOT EXISTS idx_trade_similarity_features_archetype ON trade_similarity_features(trade_archetype);
    CREATE INDEX IF NOT EXISTS idx_trade_similarity_features_regime ON trade_similarity_features(market_regime);
    CREATE INDEX IF NOT EXISTS idx_trade_similarity_features_gate_verdict ON trade_similarity_features(gate_verdict);
  `);
}

function toTradeSimilarityFeatures(row: Record<string, unknown>): TradeSimilarityFeatures {
  return {
    dossierId: String(row.dossier_id ?? ''),
    symbol: String(row.symbol ?? ''),
    signalClass: row.signal_class == null ? null : String(row.signal_class),
    tradeArchetype: row.trade_archetype == null ? null : String(row.trade_archetype),
    marketRegime: row.market_regime == null ? null : String(row.market_regime),
    volatilityBucket: row.volatility_bucket == null ? null : String(row.volatility_bucket),
    liquidityBucket: row.liquidity_bucket == null ? null : String(row.liquidity_bucket),
    entryTrigger: row.entry_trigger == null ? null : String(row.entry_trigger),
    newsSubtype: row.news_subtype == null ? null : String(row.news_subtype),
    proxyExpression: row.proxy_expression == null ? null : String(row.proxy_expression),
    catalystFreshnessBucket:
      row.catalyst_freshness_bucket == null ? null : String(row.catalyst_freshness_bucket),
    entryExtensionBucket:
      row.entry_extension_bucket == null ? null : String(row.entry_extension_bucket),
    portfolioOverlapBucket:
      row.portfolio_overlap_bucket == null ? null : String(row.portfolio_overlap_bucket),
    gateVerdict: row.gate_verdict == null ? null : String(row.gate_verdict),
    failureMode: row.failure_mode == null ? null : String(row.failure_mode),
    successDriver: row.success_driver == null ? null : String(row.success_driver),
    thesisVerdict: row.thesis_verdict == null ? null : String(row.thesis_verdict),
    entryQuality: row.entry_quality == null ? null : String(row.entry_quality),
    sizingQuality: row.sizing_quality == null ? null : String(row.sizing_quality),
    opportunityRank: row.opportunity_rank == null ? null : Number(row.opportunity_rank),
    sourceCount: row.source_count == null ? null : Number(row.source_count),
    conflictingEvidenceCount:
      row.conflicting_evidence_count == null ? null : Number(row.conflicting_evidence_count),
    executionConditionBucket:
      row.execution_condition_bucket == null ? null : String(row.execution_condition_bucket),
    sessionBucket: row.session_bucket == null ? null : String(row.session_bucket),
    regimeTransitionFlag: Number(row.regime_transition_flag ?? 0) === 1,
    createdAt: String(row.created_at ?? ''),
  };
}

export function upsertTradeSimilarityFeatures(
  input: UpsertTradeSimilarityFeaturesInput
): TradeSimilarityFeatures {
  ensureTradeSimilarityFeaturesSchema();
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO trade_similarity_features (
        dossier_id,
        symbol,
        signal_class,
        trade_archetype,
        market_regime,
        volatility_bucket,
        liquidity_bucket,
        entry_trigger,
        news_subtype,
        proxy_expression,
        catalyst_freshness_bucket,
        entry_extension_bucket,
        portfolio_overlap_bucket,
        gate_verdict,
        failure_mode,
        success_driver,
        thesis_verdict,
        entry_quality,
        sizing_quality,
        opportunity_rank,
        source_count,
        conflicting_evidence_count,
        execution_condition_bucket,
        session_bucket,
        regime_transition_flag
      ) VALUES (
        @dossierId,
        @symbol,
        @signalClass,
        @tradeArchetype,
        @marketRegime,
        @volatilityBucket,
        @liquidityBucket,
        @entryTrigger,
        @newsSubtype,
        @proxyExpression,
        @catalystFreshnessBucket,
        @entryExtensionBucket,
        @portfolioOverlapBucket,
        @gateVerdict,
        @failureMode,
        @successDriver,
        @thesisVerdict,
        @entryQuality,
        @sizingQuality,
        @opportunityRank,
        @sourceCount,
        @conflictingEvidenceCount,
        @executionConditionBucket,
        @sessionBucket,
        @regimeTransitionFlag
      )
      ON CONFLICT(dossier_id) DO UPDATE SET
        symbol = excluded.symbol,
        signal_class = excluded.signal_class,
        trade_archetype = excluded.trade_archetype,
        market_regime = excluded.market_regime,
        volatility_bucket = excluded.volatility_bucket,
        liquidity_bucket = excluded.liquidity_bucket,
        entry_trigger = excluded.entry_trigger,
        news_subtype = excluded.news_subtype,
        proxy_expression = excluded.proxy_expression,
        catalyst_freshness_bucket = excluded.catalyst_freshness_bucket,
        entry_extension_bucket = excluded.entry_extension_bucket,
        portfolio_overlap_bucket = excluded.portfolio_overlap_bucket,
        gate_verdict = excluded.gate_verdict,
        failure_mode = excluded.failure_mode,
        success_driver = excluded.success_driver,
        thesis_verdict = excluded.thesis_verdict,
        entry_quality = excluded.entry_quality,
        sizing_quality = excluded.sizing_quality,
        opportunity_rank = excluded.opportunity_rank,
        source_count = excluded.source_count,
        conflicting_evidence_count = excluded.conflicting_evidence_count,
        execution_condition_bucket = excluded.execution_condition_bucket,
        session_bucket = excluded.session_bucket,
        regime_transition_flag = excluded.regime_transition_flag
    `
  ).run({
    dossierId: input.dossierId,
    symbol: input.symbol.trim().toUpperCase(),
    signalClass: input.signalClass ?? null,
    tradeArchetype: input.tradeArchetype ?? null,
    marketRegime: input.marketRegime ?? null,
    volatilityBucket: input.volatilityBucket ?? null,
    liquidityBucket: input.liquidityBucket ?? null,
    entryTrigger: input.entryTrigger ?? null,
    newsSubtype: input.newsSubtype ?? null,
    proxyExpression: input.proxyExpression ?? null,
    catalystFreshnessBucket: input.catalystFreshnessBucket ?? null,
    entryExtensionBucket: input.entryExtensionBucket ?? null,
    portfolioOverlapBucket: input.portfolioOverlapBucket ?? null,
    gateVerdict: input.gateVerdict ?? null,
    failureMode: input.failureMode ?? null,
    successDriver: input.successDriver ?? null,
    thesisVerdict: input.thesisVerdict ?? null,
    entryQuality: input.entryQuality ?? null,
    sizingQuality: input.sizingQuality ?? null,
    opportunityRank: input.opportunityRank ?? null,
    sourceCount: input.sourceCount ?? null,
    conflictingEvidenceCount: input.conflictingEvidenceCount ?? null,
    executionConditionBucket: input.executionConditionBucket ?? null,
    sessionBucket: input.sessionBucket ?? null,
    regimeTransitionFlag: input.regimeTransitionFlag ? 1 : 0,
  });

  return getTradeSimilarityFeatures(input.dossierId);
}

export function getTradeSimilarityFeatures(dossierId: string): TradeSimilarityFeatures {
  ensureTradeSimilarityFeaturesSchema();
  const db = openDatabase();
  const row = db
    .prepare('SELECT * FROM trade_similarity_features WHERE dossier_id = ? LIMIT 1')
    .get(dossierId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Trade similarity features not found: ${dossierId}`);
  }
  return toTradeSimilarityFeatures(row);
}

export function listTradeSimilarityFeatures(
  filters: ListTradeSimilarityFeaturesFilters = {}
): TradeSimilarityFeatures[] {
  ensureTradeSimilarityFeaturesSchema();
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM trade_similarity_features
        WHERE (@symbol IS NULL OR symbol = @symbol)
          AND (@signalClass IS NULL OR signal_class = @signalClass)
          AND (@tradeArchetype IS NULL OR trade_archetype = @tradeArchetype)
          AND (@marketRegime IS NULL OR market_regime = @marketRegime)
          AND (@gateVerdict IS NULL OR gate_verdict = @gateVerdict)
        ORDER BY created_at DESC, dossier_id DESC
        LIMIT @limit
      `
    )
    .all({
      symbol: filters.symbol?.trim().toUpperCase() ?? null,
      signalClass: filters.signalClass ?? null,
      tradeArchetype: filters.tradeArchetype ?? null,
      marketRegime: filters.marketRegime ?? null,
      gateVerdict: filters.gateVerdict ?? null,
      limit: filters.limit ?? 100,
    }) as Array<Record<string, unknown>>;
  return rows.map(toTradeSimilarityFeatures);
}
