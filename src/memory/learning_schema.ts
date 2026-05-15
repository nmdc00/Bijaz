import type Database from 'better-sqlite3';

export const LEARNING_EXAMPLES_VIEW_SQL = `CREATE VIEW learning_examples AS
SELECT
  id,
  domain,
  regime_tag           AS regime,
  strategy_class,
  symbol,
  model_probability,
  market_probability,
  executed,
  position_size,
  CASE WHEN outcome = 'YES' THEN 1 ELSE 0 END                               AS outcome_value,
  pnl,
  (model_probability  - CASE WHEN outcome = 'YES' THEN 1.0 ELSE 0.0 END)
  * (model_probability  - CASE WHEN outcome = 'YES' THEN 1.0 ELSE 0.0 END)  AS brier_model,
  (market_probability - CASE WHEN outcome = 'YES' THEN 1.0 ELSE 0.0 END)
  * (market_probability - CASE WHEN outcome = 'YES' THEN 1.0 ELSE 0.0 END)  AS brier_market,
  created_at,
  outcome_timestamp    AS resolved_at
FROM predictions
WHERE outcome_basis     = 'final'
  AND model_probability  IS NOT NULL
  AND market_probability IS NOT NULL
  AND learning_comparable = 1
  AND outcome            IS NOT NULL;`;

export const LEARNING_CASES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS learning_cases (
    id TEXT PRIMARY KEY,
    case_type TEXT NOT NULL CHECK(case_type IN ('comparable_forecast', 'execution_quality', 'thesis_quality', 'intervention_quality', 'regret_case')),
    domain TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    comparable INTEGER NOT NULL CHECK(comparable IN (0, 1)),
    comparator_kind TEXT,
    source_prediction_id TEXT,
    source_trade_id INTEGER,
    source_dossier_id TEXT,
    source_hypothesis_id TEXT,
    source_artifact_id INTEGER,
    belief_payload TEXT,
    baseline_payload TEXT,
    context_payload TEXT,
    action_payload TEXT,
    outcome_payload TEXT,
    quality_payload TEXT,
    policy_input_payload TEXT,
    exclusion_reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);`;

const LEARNING_CASES_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_type ON learning_cases(case_type);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_domain ON learning_cases(domain);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_comparable ON learning_cases(comparable);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_prediction ON learning_cases(source_prediction_id);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_trade ON learning_cases(source_trade_id);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_dossier ON learning_cases(source_dossier_id);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_hypothesis ON learning_cases(source_hypothesis_id);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_entity ON learning_cases(entity_type, entity_id);',
];

const COMPARABLE_LEARNING_CASES_VIEW_SQL = `CREATE VIEW comparable_learning_cases AS
SELECT *
FROM learning_cases
WHERE case_type = 'comparable_forecast'
  AND comparable = 1;`;

const EXECUTION_LEARNING_CASES_VIEW_SQL = `CREATE VIEW execution_learning_cases AS
SELECT *
FROM learning_cases
WHERE case_type = 'execution_quality';`;

const THESIS_LEARNING_CASES_VIEW_SQL = `CREATE VIEW thesis_learning_cases AS
SELECT *
FROM learning_cases
WHERE case_type = 'thesis_quality';`;

const INTERVENTION_LEARNING_CASES_VIEW_SQL = `CREATE VIEW intervention_learning_cases AS
SELECT *
FROM learning_cases
WHERE case_type = 'intervention_quality';`;

const REGRET_LEARNING_CASES_VIEW_SQL = `CREATE VIEW regret_learning_cases AS
SELECT *
FROM learning_cases
WHERE case_type = 'regret_case';`;

const TRADE_DOSSIERS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS trade_dossiers (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open', 'closed')),
    direction TEXT CHECK(direction IN ('long', 'short')),
    strategy_source TEXT,
    execution_mode TEXT CHECK(execution_mode IN ('paper', 'live')),
    source_trade_id INTEGER,
    source_prediction_id TEXT,
    source_hypothesis_id TEXT,
    proposal_record_id INTEGER,
    trigger_reason TEXT,
    opened_at TEXT,
    closed_at TEXT,
    dossier_payload TEXT,
    review_payload TEXT,
    retrieval_payload TEXT,
    policy_trace_payload TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);`;

const TRADE_COUNTERFACTUALS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS trade_counterfactuals (
    id TEXT PRIMARY KEY,
    dossier_id TEXT NOT NULL,
    counterfactual_type TEXT NOT NULL CHECK(counterfactual_type IN (
      'no_trade',
      'full_size',
      'approved_size',
      'delay_entry',
      'invalidation_exit',
      'ttl_exit',
      'alternate_expression',
      'leverage_cap'
    )),
    baseline_kind TEXT,
    summary TEXT,
    score REAL,
    estimated_net_pnl_usd REAL,
    estimated_r_multiple REAL,
    value_add_usd REAL,
    confidence REAL,
    inputs_payload TEXT,
    result_payload TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);`;

const TRADE_SIMILARITY_FEATURES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS trade_similarity_features (
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
);`;

const TRADE_POLICY_ADJUSTMENTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS trade_policy_adjustments (
    id TEXT PRIMARY KEY,
    policy_domain TEXT NOT NULL,
    policy_key TEXT NOT NULL,
    scope_payload TEXT,
    adjustment_type TEXT NOT NULL,
    old_value REAL,
    new_value REAL,
    delta REAL,
    evidence_count INTEGER,
    evidence_window_start TEXT,
    evidence_window_end TEXT,
    reason_summary TEXT,
    confidence REAL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT
);`;

export const LEGACY_PERP_CONTAMINATION_WHERE_SQL = `domain = 'perp'
  AND outcome_basis = 'final'
  AND predicted_outcome IN ('YES', 'NO')
  AND model_probability IS NOT NULL
  AND market_probability = 0.5
  AND learning_comparable = 1`;

export const OPEN_SYNTHETIC_PERP_COMPARABLE_WHERE_SQL = `domain = 'perp'
  AND predicted_outcome IN ('YES', 'NO')
  AND model_probability IS NOT NULL
  AND market_probability = 0.5
  AND learning_comparable = 1`;

function hasPredictionColumns(db: Database.Database, columnNames: string[]): boolean {
  const hasPredictionsTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'predictions' LIMIT 1")
    .get();
  if (!hasPredictionsTable) {
    return false;
  }

  const columns = db.prepare("PRAGMA table_info('predictions')").all() as Array<{ name?: string }>;
  const present = new Set(columns.map((column) => String(column.name ?? '')));
  return columnNames.every((name) => present.has(name));
}

function rebuildLearningCasesTable(db: Database.Database): void {
  const legacyColumns = db.prepare("PRAGMA table_info('learning_cases')").all() as Array<{ name?: string }>;
  const legacyNames = new Set(legacyColumns.map((column) => String(column.name ?? '')));
  const legacySourceDossier = legacyNames.has('source_dossier_id') ? 'source_dossier_id' : 'NULL';
  const legacySourceHypothesis = legacyNames.has('source_hypothesis_id')
    ? 'source_hypothesis_id'
    : 'NULL';
  db.exec('ALTER TABLE learning_cases RENAME TO learning_cases_legacy_v21');
  db.exec(LEARNING_CASES_TABLE_SQL);
  db.exec(`
    INSERT INTO learning_cases (
      id,
      case_type,
      domain,
      entity_type,
      entity_id,
      comparable,
      comparator_kind,
      source_prediction_id,
      source_trade_id,
      source_dossier_id,
      source_hypothesis_id,
      source_artifact_id,
      belief_payload,
      baseline_payload,
      context_payload,
      action_payload,
      outcome_payload,
      quality_payload,
      policy_input_payload,
      exclusion_reason,
      created_at,
      updated_at
    )
    SELECT
      id,
      case_type,
      domain,
      entity_type,
      entity_id,
      comparable,
      comparator_kind,
      source_prediction_id,
      source_trade_id,
      ${legacySourceDossier},
      ${legacySourceHypothesis},
      source_artifact_id,
      belief_payload,
      baseline_payload,
      context_payload,
      action_payload,
      outcome_payload,
      quality_payload,
      policy_input_payload,
      exclusion_reason,
      created_at,
      updated_at
    FROM learning_cases_legacy_v21
  `);
  db.exec('DROP TABLE learning_cases_legacy_v21');
}

function ensureTableColumns(
  db: Database.Database,
  tableName: string,
  columnsToAdd: Array<{ name: string; definition: string }>
): void {
  const columns = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  for (const column of columnsToAdd) {
    if (columnNames.has(column.name)) {
      continue;
    }
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column.definition}`);
    columnNames.add(column.name);
  }
}

function ensureAdaptiveDecisionTables(db: Database.Database): void {
  db.exec(TRADE_DOSSIERS_TABLE_SQL);
  ensureTableColumns(db, 'trade_dossiers', [
    { name: 'source_hypothesis_id', definition: 'source_hypothesis_id TEXT' },
    { name: 'retrieval_payload', definition: 'retrieval_payload TEXT' },
    { name: 'policy_trace_payload', definition: 'policy_trace_payload TEXT' },
  ]);
  db.exec('CREATE INDEX IF NOT EXISTS idx_trade_dossiers_symbol ON trade_dossiers(symbol)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_trade_dossiers_status ON trade_dossiers(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_trade_dossiers_trade ON trade_dossiers(source_trade_id)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_trade_dossiers_prediction ON trade_dossiers(source_prediction_id)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_trade_dossiers_hypothesis ON trade_dossiers(source_hypothesis_id)'
  );

  db.exec(TRADE_COUNTERFACTUALS_TABLE_SQL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_trade_counterfactuals_dossier ON trade_counterfactuals(dossier_id)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_trade_counterfactuals_type ON trade_counterfactuals(counterfactual_type)'
  );

  db.exec(TRADE_SIMILARITY_FEATURES_TABLE_SQL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_trade_similarity_features_symbol ON trade_similarity_features(symbol)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_trade_similarity_features_signal_class ON trade_similarity_features(signal_class)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_trade_similarity_features_archetype ON trade_similarity_features(trade_archetype)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_trade_similarity_features_regime ON trade_similarity_features(market_regime)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_trade_similarity_features_gate_verdict ON trade_similarity_features(gate_verdict)'
  );

  db.exec(TRADE_POLICY_ADJUSTMENTS_TABLE_SQL);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_trade_policy_adjustments_domain_key
    ON trade_policy_adjustments(policy_domain, policy_key)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_trade_policy_adjustments_active
    ON trade_policy_adjustments(active, created_at)
  `);
}

export function ensureLearningSchema(db: Database.Database): void {
  const existingTableSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'learning_cases' LIMIT 1")
    .get() as { sql?: string } | undefined;
  if (!existingTableSql) {
    db.exec(LEARNING_CASES_TABLE_SQL);
  } else if (
    !String(existingTableSql.sql ?? '').includes("'thesis_quality'") ||
    !String(existingTableSql.sql ?? '').includes("'intervention_quality'") ||
    !String(existingTableSql.sql ?? '').includes("'regret_case'") ||
    !String(existingTableSql.sql ?? '').includes('source_hypothesis_id')
  ) {
    rebuildLearningCasesTable(db);
  }
  ensureTableColumns(db, 'learning_cases', [
    { name: 'source_dossier_id', definition: 'source_dossier_id TEXT' },
    { name: 'source_hypothesis_id', definition: 'source_hypothesis_id TEXT' },
  ]);
  for (const statement of LEARNING_CASES_INDEX_SQL) {
    db.exec(statement);
  }

  ensureAdaptiveDecisionTables(db);
  cleanupSyntheticPerpComparableRows(db);

  // Recreate views explicitly so older definitions do not survive forever.
  db.exec('DROP VIEW IF EXISTS learning_examples;');
  db.exec(LEARNING_EXAMPLES_VIEW_SQL);
  db.exec('DROP VIEW IF EXISTS comparable_learning_cases;');
  db.exec(COMPARABLE_LEARNING_CASES_VIEW_SQL);
  db.exec('DROP VIEW IF EXISTS execution_learning_cases;');
  db.exec(EXECUTION_LEARNING_CASES_VIEW_SQL);
  db.exec('DROP VIEW IF EXISTS thesis_learning_cases;');
  db.exec(THESIS_LEARNING_CASES_VIEW_SQL);
  db.exec('DROP VIEW IF EXISTS intervention_learning_cases;');
  db.exec(INTERVENTION_LEARNING_CASES_VIEW_SQL);
  db.exec('DROP VIEW IF EXISTS regret_learning_cases;');
  db.exec(REGRET_LEARNING_CASES_VIEW_SQL);
}

export function cleanupLegacyPerpComparableRows(db: Database.Database): number {
  if (
    !hasPredictionColumns(db, [
      'domain',
      'outcome_basis',
      'predicted_outcome',
      'model_probability',
      'market_probability',
      'learning_comparable',
    ])
  ) {
    return 0;
  }
  const result = db
    .prepare(
      `UPDATE predictions
       SET learning_comparable = 0
       WHERE ${LEGACY_PERP_CONTAMINATION_WHERE_SQL}`
    )
    .run();
  return result.changes;
}

export function cleanupSyntheticPerpComparableRows(db: Database.Database): number {
  if (
    !hasPredictionColumns(db, [
      'domain',
      'predicted_outcome',
      'model_probability',
      'market_probability',
      'learning_comparable',
    ])
  ) {
    return 0;
  }
  const result = db
    .prepare(
      `UPDATE predictions
       SET learning_comparable = 0
       WHERE ${OPEN_SYNTHETIC_PERP_COMPARABLE_WHERE_SQL}`
    )
    .run();
  return result.changes;
}

export type LearningSchemaSummary = {
  predictionCount: number;
  comparablePredictionCount: number;
  contaminatedComparableCount: number;
  learningExamplesCount: number;
  learningCasesCount: number;
  comparableLearningCasesCount: number;
  executionLearningCasesCount: number;
};

function countIfTableExists(db: Database.Database, tableName: string): number {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName);
  if (!exists) {
    return 0;
  }
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${tableName}`).get() as { c: number };
  return row.c;
}

function countIfViewExists(db: Database.Database, viewName: string): number {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ? LIMIT 1")
    .get(viewName);
  if (!exists) {
    return 0;
  }
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${viewName}`).get() as { c: number };
  return row.c;
}

export function summarizeLearningSchema(db: Database.Database): LearningSchemaSummary {
  const predictionCount = (db.prepare('SELECT COUNT(*) AS c FROM predictions').get() as { c: number }).c;
  const comparablePredictionCount = (
    db.prepare('SELECT COUNT(*) AS c FROM predictions WHERE learning_comparable = 1').get() as {
      c: number;
    }
  ).c;
  const contaminatedComparableCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM predictions WHERE ${LEGACY_PERP_CONTAMINATION_WHERE_SQL}`).get() as {
      c: number;
    }
  ).c;

  return {
    predictionCount,
    comparablePredictionCount,
    contaminatedComparableCount,
    learningExamplesCount: countIfViewExists(db, 'learning_examples'),
    learningCasesCount: countIfTableExists(db, 'learning_cases'),
    comparableLearningCasesCount: countIfViewExists(db, 'comparable_learning_cases'),
    executionLearningCasesCount: countIfViewExists(db, 'execution_learning_cases'),
  };
}
