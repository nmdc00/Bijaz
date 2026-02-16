import { openDatabase } from './db.js';

export type AdaptiveAutonomyState = {
  minEdgeOverride: number | null;
  maxTradesPerScanOverride: number | null;
  leverageCapOverride: number | null;
  observationOnlyUntilMs: number | null;
  reason: string | null;
  updatedAt: string;
};

const DEFAULT_STATE: AdaptiveAutonomyState = {
  minEdgeOverride: null,
  maxTradesPerScanOverride: null,
  leverageCapOverride: null,
  observationOnlyUntilMs: null,
  reason: null,
  updatedAt: new Date(0).toISOString(),
};

function ensureAutonomyPolicyStateTable(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS autonomy_policy_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function parsePayload(raw: unknown): AdaptiveAutonomyState {
  if (typeof raw !== 'string') return { ...DEFAULT_STATE };
  try {
    const parsed = JSON.parse(raw) as Partial<AdaptiveAutonomyState>;
    return {
      minEdgeOverride:
        typeof parsed.minEdgeOverride === 'number' && Number.isFinite(parsed.minEdgeOverride)
          ? parsed.minEdgeOverride
          : null,
      maxTradesPerScanOverride:
        typeof parsed.maxTradesPerScanOverride === 'number' &&
        Number.isFinite(parsed.maxTradesPerScanOverride)
          ? Math.max(1, Math.floor(parsed.maxTradesPerScanOverride))
          : null,
      leverageCapOverride:
        typeof parsed.leverageCapOverride === 'number' && Number.isFinite(parsed.leverageCapOverride)
          ? Math.max(1, parsed.leverageCapOverride)
          : null,
      observationOnlyUntilMs:
        typeof parsed.observationOnlyUntilMs === 'number' &&
        Number.isFinite(parsed.observationOnlyUntilMs)
          ? parsed.observationOnlyUntilMs
          : null,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim().length > 0 ? parsed.reason : null,
      updatedAt:
        typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim().length > 0
          ? parsed.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function getAutonomyPolicyState(): AdaptiveAutonomyState {
  try {
    ensureAutonomyPolicyStateTable();
    const db = openDatabase();
    const row = db
      .prepare(
        `
        SELECT payload, updated_at
        FROM autonomy_policy_state
        WHERE id = 1
      `
      )
      .get() as { payload?: string; updated_at?: string } | undefined;

    const state = parsePayload(row?.payload);
    if (row?.updated_at) {
      state.updatedAt = String(row.updated_at);
    }
    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function upsertAutonomyPolicyState(patch: Partial<AdaptiveAutonomyState>): AdaptiveAutonomyState {
  try {
    ensureAutonomyPolicyStateTable();
    const db = openDatabase();
    const current = getAutonomyPolicyState();
    const next: AdaptiveAutonomyState = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    db.prepare(
      `
        INSERT INTO autonomy_policy_state (id, payload, updated_at)
        VALUES (1, @payload, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `
    ).run({ payload: JSON.stringify(next) });

    return next;
  } catch {
    return {
      ...DEFAULT_STATE,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }
}

export function clearExpiredObservationMode(nowMs = Date.now()): AdaptiveAutonomyState {
  const current = getAutonomyPolicyState();
  if (current.observationOnlyUntilMs == null || current.observationOnlyUntilMs > nowMs) {
    return current;
  }
  return upsertAutonomyPolicyState({
    observationOnlyUntilMs: null,
    reason: null,
  });
}
