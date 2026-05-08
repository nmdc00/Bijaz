import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { summarizeLearningSchema } from '../src/memory/learning_schema.js';

function resolveDbPath(): string {
  const cliPath = process.argv[2];
  return cliPath ?? process.env.THUFIR_DB_PATH ?? join(homedir(), '.thufir', 'thufir.sqlite');
}

function readSql(db: Database.Database, type: 'table' | 'view', name: string): string | null {
  const row = db
    .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1')
    .get(type, name) as { sql?: string } | undefined;
  return row?.sql ?? null;
}

const dbPath = resolveDbPath();
const db = new Database(dbPath, { readonly: true });

const summary = summarizeLearningSchema(db);
console.log(JSON.stringify({
  dbPath,
  summary,
  objects: {
    learningExamplesView: readSql(db, 'view', 'learning_examples'),
    comparableLearningCasesView: readSql(db, 'view', 'comparable_learning_cases'),
    executionLearningCasesView: readSql(db, 'view', 'execution_learning_cases'),
    learningCasesTable: readSql(db, 'table', 'learning_cases'),
  },
}, null, 2));

db.close();
