import { openDatabase } from './db.js';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export interface AgentPlaybookRow {
  key: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function safeJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function ensurePlaybooksSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_playbooks (
      key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agent_playbooks_updated ON agent_playbooks(updated_at);
  `);
}

function resolvePlaybookFilePath(key: string): string | null {
  const normalizedKey = key.trim().replace(/\\/g, '/');
  if (!normalizedKey.toLowerCase().endsWith('.md')) return null;
  if (isAbsolute(normalizedKey)) return null;
  if (normalizedKey.includes('..')) return null;

  const roots = [
    process.env.THUFIR_WORKSPACE,
    process.env.THUFIR_AGENT_WORKSPACE,
    resolve(process.cwd(), 'workspace'),
    process.cwd(),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => resolve(value.trim()));

  for (const root of roots) {
    const candidate = resolve(root, normalizedKey);
    const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (candidate !== root && !candidate.startsWith(rootPrefix)) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function loadPlaybookFromFilesystem(key: string): AgentPlaybookRow | null {
  const filePath = resolvePlaybookFilePath(key);
  if (!filePath) return null;
  try {
    const content = readFileSync(filePath, 'utf8');
    const title = basename(filePath, extname(filePath)) || key;
    upsertPlaybook({ key, title, content, tags: ['filesystem'] });
    return {
      key,
      title,
      content,
      tags: ['filesystem'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function upsertPlaybook(input: {
  key: string;
  title: string;
  content: string;
  tags?: string[];
}): void {
  ensurePlaybooksSchema();
  const db = openDatabase();
  db.prepare(
    `
    INSERT INTO agent_playbooks (key, title, content, tags_json)
    VALUES (@key, @title, @content, @tagsJson)
    ON CONFLICT(key) DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      tags_json = excluded.tags_json,
      updated_at = datetime('now')
  `
  ).run({
    key: input.key,
    title: input.title,
    content: input.content,
    tagsJson: safeJson(input.tags ?? []),
  });
}

export function getPlaybook(key: string): AgentPlaybookRow | null {
  ensurePlaybooksSchema();
  const db = openDatabase();
  const row = db
    .prepare(
      `
      SELECT
        key,
        title,
        content,
        tags_json as tagsJson,
        created_at as createdAt,
        updated_at as updatedAt
      FROM agent_playbooks
      WHERE key = ?
      LIMIT 1
    `
    )
    .get(key) as
    | {
        key: string;
        title: string;
        content: string;
        tagsJson: string | null;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;

  if (!row) {
    return loadPlaybookFromFilesystem(key);
  }
  return {
    key: row.key,
    title: row.title,
    content: row.content,
    tags: parseJson<string[]>(row.tagsJson) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function searchPlaybooks(params: {
  query: string;
  limit?: number;
}): AgentPlaybookRow[] {
  ensurePlaybooksSchema();
  const db = openDatabase();
  const q = params.query.trim();
  if (!q) return [];
  const limit = Math.max(1, Math.min(50, Number(params.limit ?? 8) || 8));

  // Simple LIKE search. Good enough for now; QMD can later index playbooks.
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `
      SELECT
        key,
        title,
        content,
        tags_json as tagsJson,
        created_at as createdAt,
        updated_at as updatedAt
      FROM agent_playbooks
      WHERE title LIKE @like OR content LIKE @like
      ORDER BY updated_at DESC
      LIMIT @limit
    `
    )
    .all({ like, limit }) as Array<{
    key: string;
    title: string;
    content: string;
    tagsJson: string | null;
    createdAt: string;
    updatedAt: string;
  }>;

  const mapped = rows.map((row) => ({
    key: row.key,
    title: row.title,
    content: row.content,
    tags: parseJson<string[]>(row.tagsJson) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

  if (mapped.length > 0) return mapped;

  const fallbackKeys: string[] = [];
  const queryLower = q.toLowerCase();
  if (q.endsWith('.md')) {
    fallbackKeys.push(q);
  } else {
    fallbackKeys.push(`${q}.md`);
    fallbackKeys.push(`${q.toUpperCase()}.md`);
  }
  if (queryLower.includes('heartbeat')) {
    fallbackKeys.push('HEARTBEAT.md');
  }

  const seen = new Set<string>();
  const fallbackRows: AgentPlaybookRow[] = [];
  for (const key of fallbackKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const row = getPlaybook(key);
    if (row) fallbackRows.push(row);
    if (fallbackRows.length >= limit) break;
  }
  return fallbackRows;
}
