import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const DEFAULT_DB_PATH = join(homedir(), '.thufir', 'thufir.sqlite');
const INSTANCES = new Map<string, Database.Database>();

function getSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(here, 'schema.sql');
  return readFileSync(schemaPath, 'utf-8');
}

function ensureDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function applySchema(db: Database.Database): void {
  migratePredictionsForDelphiResolution(db);
  const schemaSql = getSchemaSql();
  db.exec(schemaSql);
  migratePredictionsForDelphiResolution(db);
  migrateAlertPersistenceLifecycle(db);
}

function migratePredictionsForDelphiResolution(db: Database.Database): void {
  const hasPredictionsTable = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'predictions' LIMIT 1"
    )
    .get();
  if (!hasPredictionsTable) {
    return;
  }

  const columns = db
    .prepare("PRAGMA table_info('predictions')")
    .all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  const addColumnIfMissing = (name: string, definition: string): void => {
    if (columnNames.has(name)) {
      return;
    }
    db.exec(`ALTER TABLE predictions ADD COLUMN ${definition}`);
    columnNames.add(name);
  };

  addColumnIfMissing(
    'domain',
    "domain TEXT"
  );
  addColumnIfMissing('session_tag', 'session_tag TEXT');
  addColumnIfMissing('regime_tag', 'regime_tag TEXT');
  addColumnIfMissing('strategy_class', 'strategy_class TEXT');
  addColumnIfMissing('symbol', 'symbol TEXT');
  addColumnIfMissing('created_at', 'created_at TEXT');
  addColumnIfMissing(
    'horizon_minutes',
    'horizon_minutes INTEGER CHECK(horizon_minutes IS NULL OR horizon_minutes > 0)'
  );
  addColumnIfMissing('expires_at', 'expires_at TEXT');
  addColumnIfMissing('context_tags', 'context_tags TEXT');
  addColumnIfMissing(
    'resolution_status',
    "resolution_status TEXT NOT NULL DEFAULT 'open' CHECK(resolution_status IN ('open', 'resolved_true', 'resolved_false', 'unresolved_error'))"
  );
  addColumnIfMissing('resolution_metadata', 'resolution_metadata TEXT');
  addColumnIfMissing('resolution_error', 'resolution_error TEXT');
  addColumnIfMissing('resolution_timestamp', 'resolution_timestamp TEXT');
  addColumnIfMissing('outcome', "outcome TEXT");
  addColumnIfMissing('outcome_timestamp', 'outcome_timestamp TEXT');
  addColumnIfMissing('pnl', 'pnl REAL');
  addColumnIfMissing('brier_contribution', 'brier_contribution REAL');

  db.exec(`
    UPDATE predictions
    SET created_at = datetime('now')
    WHERE created_at IS NULL OR TRIM(created_at) = ''
  `);

  db.exec(`
    UPDATE predictions
    SET domain = 'global'
    WHERE domain IS NULL OR TRIM(domain) = ''
  `);

  db.exec(`
    UPDATE predictions
    SET resolution_status = 'open'
    WHERE resolution_status IS NULL
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_predictions_domain
    ON predictions(domain)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_predictions_resolution_status
    ON predictions(resolution_status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_predictions_open_expiry
    ON predictions(expires_at, created_at)
    WHERE resolution_status = 'open' AND expires_at IS NOT NULL
  `);
}

function migrateAlertPersistenceLifecycle(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'high', 'critical')),
      summary TEXT NOT NULL,
      message TEXT,
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open', 'suppressed', 'sent', 'resolved')),
      metadata_json TEXT,
      occurred_at TEXT,
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      suppressed_at TEXT,
      sent_at TEXT,
      resolved_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK(event_type IN ('open', 'suppressed', 'sent', 'resolved', 'acknowledged', 'delivery')),
      from_state TEXT,
      to_state TEXT,
      reason_code TEXT,
      payload_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('retrying', 'sent', 'failed')),
      attempt INTEGER NOT NULL DEFAULT 1,
      provider_message_id TEXT,
      error TEXT,
      metadata_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const columns = db.prepare("PRAGMA table_info('alerts')").all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  const addColumnIfMissing = (name: string, definition: string): void => {
    if (columnNames.has(name)) {
      return;
    }
    db.exec(`ALTER TABLE alerts ADD COLUMN ${definition}`);
    columnNames.add(name);
  };

  addColumnIfMissing('state', "state TEXT NOT NULL DEFAULT 'open'");
  addColumnIfMissing('metadata_json', 'metadata_json TEXT');
  addColumnIfMissing('occurred_at', 'occurred_at TEXT');
  addColumnIfMissing('acknowledged_at', 'acknowledged_at TEXT');
  addColumnIfMissing('acknowledged_by', 'acknowledged_by TEXT');
  addColumnIfMissing('suppressed_at', 'suppressed_at TEXT');
  addColumnIfMissing('sent_at', 'sent_at TEXT');
  addColumnIfMissing('resolved_at', 'resolved_at TEXT');
  addColumnIfMissing('last_error', 'last_error TEXT');
  addColumnIfMissing('created_at', 'created_at TEXT');
  addColumnIfMissing('updated_at', 'updated_at TEXT');

  db.exec(`
    UPDATE alerts
    SET state = 'open'
    WHERE state IS NULL OR TRIM(state) = ''
  `);
  db.exec(`
    UPDATE alerts
    SET created_at = COALESCE(created_at, datetime('now')),
        updated_at = COALESCE(updated_at, datetime('now'))
    WHERE created_at IS NULL OR updated_at IS NULL
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_state
    ON alerts(state)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_dedupe_key
    ON alerts(dedupe_key)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_created
    ON alerts(created_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_events_alert_id
    ON alert_events(alert_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_events_created
    ON alert_events(created_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_alert_id
    ON alert_deliveries(alert_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_status
    ON alert_deliveries(status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_created
    ON alert_deliveries(created_at)
  `);
}

export function openDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? process.env.THUFIR_DB_PATH ?? DEFAULT_DB_PATH;

  const existing = INSTANCES.get(resolvedPath);
  if (existing) {
    return existing;
  }

  ensureDirectory(resolvedPath);

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  applySchema(db);

  INSTANCES.set(resolvedPath, db);
  return db;
}
