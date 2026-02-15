import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export function storeChatMessage(params: {
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt?: string;
}): string {
  const db = openDatabase();
  const id = randomUUID();
  const createdAt = params.createdAt ?? new Date().toISOString();

  db.prepare(
    `
      INSERT INTO chat_messages (id, session_id, role, content, created_at)
      VALUES (@id, @sessionId, @role, @content, @createdAt)
    `
  ).run({
    id,
    sessionId: params.sessionId,
    role: params.role,
    content: params.content,
    createdAt,
  });

  return id;
}

export function listChatMessagesByIds(ids: string[]): ChatMessageRecord[] {
  if (ids.length === 0) {
    return [];
  }
  const db = openDatabase();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
        SELECT id, session_id as sessionId, role, content, created_at as createdAt
        FROM chat_messages
        WHERE id IN (${placeholders})
      `
    )
    .all(...ids) as Array<Record<string, unknown>>;

  const map = new Map(rows.map((row) => [String(row.id), row]));
  return ids
    .map((id) => map.get(id))
    .filter(Boolean)
    .map((row) => ({
      id: String(row!.id),
      sessionId: String(row!.sessionId),
      role: row!.role as ChatMessageRecord['role'],
      content: String(row!.content),
      createdAt: String(row!.createdAt),
    }));
}

export function clearChatMessages(sessionId: string): void {
  const db = openDatabase();
  db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`).run(sessionId);
  db.prepare(
    `
      DELETE FROM chat_embeddings
      WHERE message_id NOT IN (SELECT id FROM chat_messages)
    `
  ).run();
}

export function pruneChatMessages(retentionDays: number): number {
  const days = Math.max(1, Math.floor(retentionDays));
  const db = openDatabase();
  const cutoff = `-${days} days`;
  const toDelete = db
    .prepare(
      `
        SELECT id FROM chat_messages
        WHERE created_at < datetime('now', ?)
      `
    )
    .all(cutoff) as Array<{ id: string }>;

  if (toDelete.length === 0) {
    return 0;
  }

  const ids = toDelete.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM chat_embeddings WHERE message_id IN (${placeholders})`
  ).run(...ids);
  const result = db
    .prepare(`DELETE FROM chat_messages WHERE id IN (${placeholders})`)
    .run(...ids);

  return result.changes ?? 0;
}
