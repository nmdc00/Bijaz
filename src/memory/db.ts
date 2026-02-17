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
  const schemaSql = getSchemaSql();
  db.exec(schemaSql);
  migratePredictionsForDelphiResolution(db);
}

function migratePredictionsForDelphiResolution(db: Database.Database): void {
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

  db.exec(`
    UPDATE predictions
    SET resolution_status = 'open'
    WHERE resolution_status IS NULL
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
