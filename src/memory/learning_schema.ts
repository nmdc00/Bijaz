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
    case_type TEXT NOT NULL CHECK(case_type IN ('comparable_forecast', 'execution_quality', 'thesis_quality')),
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

export function ensureLearningSchema(db: Database.Database): void {
  const existingTableSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'learning_cases' LIMIT 1")
    .get() as { sql?: string } | undefined;
  if (!existingTableSql) {
    db.exec(LEARNING_CASES_TABLE_SQL);
  } else if (
    !String(existingTableSql.sql ?? '').includes("'thesis_quality'") ||
    !String(existingTableSql.sql ?? '').includes('source_hypothesis_id')
  ) {
    rebuildLearningCasesTable(db);
  }
  const columns = db.prepare("PRAGMA table_info('learning_cases')").all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  if (!columnNames.has('source_dossier_id')) {
    db.exec('ALTER TABLE learning_cases ADD COLUMN source_dossier_id TEXT');
  }
  if (!columnNames.has('source_hypothesis_id')) {
    db.exec('ALTER TABLE learning_cases ADD COLUMN source_hypothesis_id TEXT');
  }
  for (const statement of LEARNING_CASES_INDEX_SQL) {
    db.exec(statement);
  }

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
