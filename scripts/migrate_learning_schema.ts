import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { openDatabase } from '../src/memory/db.js';
import {
  cleanupLegacyPerpComparableRows,
  ensureLearningSchema,
  summarizeLearningSchema,
} from '../src/memory/learning_schema.js';

function usage(): never {
  console.error('Usage: pnpm exec tsx scripts/migrate_learning_schema.ts <db-path> [--apply]');
  process.exit(1);
}

function resolveArgs(): { dbPath: string; apply: boolean } {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dbPath = args.find((arg) => arg !== '--apply')
    ?? process.env.THUFIR_DB_PATH
    ?? join(homedir(), '.thufir', 'thufir.sqlite');
  if (!dbPath) {
    usage();
  }
  return { dbPath, apply };
}

function backupDatabase(dbPath: string): string {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const backupPath = `${dbPath}.${stamp}.bak`;
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(dbPath, backupPath);
  return backupPath;
}

const { dbPath, apply } = resolveArgs();

if (!apply) {
  const db = new Database(dbPath, { readonly: true });
  console.log(JSON.stringify({
    mode: 'dry-run',
    dbPath,
    summary: summarizeLearningSchema(db),
  }, null, 2));
  db.close();
  process.exit(0);
}

const backupPath = backupDatabase(dbPath);
const db = openDatabase(dbPath);

const before = summarizeLearningSchema(db);
const tx = db.transaction(() => {
  const changed = cleanupLegacyPerpComparableRows(db);
  ensureLearningSchema(db);
  return changed;
});
const cleanedRows = tx();
const after = summarizeLearningSchema(db);

console.log(JSON.stringify({
  mode: 'apply',
  dbPath,
  backupPath,
  cleanedRows,
  before,
  after,
}, null, 2));

db.close();
