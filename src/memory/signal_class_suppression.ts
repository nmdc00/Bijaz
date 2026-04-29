import { openDatabase } from './db.js';

export type SignalClassSuppression = {
  signalClass: string;
  suppressedUntilMs: number;
  reason: string;
  updatedAt: string;
};

function ensureTable(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_class_suppression (
      signal_class TEXT PRIMARY KEY,
      suppressed_until_ms INTEGER NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function upsertSuppression(entry: Omit<SignalClassSuppression, 'updatedAt'>): void {
  try {
    ensureTable();
    const db = openDatabase();
    db.prepare(`
      INSERT INTO signal_class_suppression (signal_class, suppressed_until_ms, reason, updated_at)
      VALUES (@signalClass, @suppressedUntilMs, @reason, @updatedAt)
      ON CONFLICT(signal_class) DO UPDATE SET
        suppressed_until_ms = excluded.suppressed_until_ms,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `).run({ ...entry, updatedAt: new Date().toISOString() });
  } catch {
    // non-fatal
  }
}

export function isSuppressed(signalClass: string, nowMs = Date.now()): boolean {
  try {
    ensureTable();
    const db = openDatabase();
    const row = db
      .prepare(
        `SELECT suppressed_until_ms FROM signal_class_suppression
         WHERE signal_class = ? AND suppressed_until_ms > ?`
      )
      .get(signalClass, nowMs) as { suppressed_until_ms: number } | undefined;
    return row != null;
  } catch {
    return false;
  }
}

export function listActiveSuppressed(nowMs = Date.now()): SignalClassSuppression[] {
  try {
    ensureTable();
    const db = openDatabase();
    const rows = db
      .prepare(
        `SELECT signal_class, suppressed_until_ms, reason, updated_at
         FROM signal_class_suppression WHERE suppressed_until_ms > ?
         ORDER BY suppressed_until_ms ASC`
      )
      .all(nowMs) as Array<{
        signal_class: string;
        suppressed_until_ms: number;
        reason: string;
        updated_at: string;
      }>;
    return rows.map((r) => ({
      signalClass: r.signal_class,
      suppressedUntilMs: r.suppressed_until_ms,
      reason: r.reason,
      updatedAt: r.updated_at,
    }));
  } catch {
    return [];
  }
}

export function clearExpired(nowMs = Date.now()): number {
  try {
    ensureTable();
    const db = openDatabase();
    const result = db
      .prepare(`DELETE FROM signal_class_suppression WHERE suppressed_until_ms <= ?`)
      .run(nowMs);
    return result.changes;
  } catch {
    return 0;
  }
}
