import { createHash, randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';
import type {
  NormalizedEvent,
  NormalizedEventInput,
  EventThought,
  EventThoughtInput,
  EventForecast,
  EventForecastInput,
  EventOutcome,
  EventOutcomeInput,
  ForecastStatus,
} from '../events/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJsonArray<T>(value: string | null): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Deterministic event key: SHA-256 of (title.toLowerCase().trim() + occurredAt.slice(0,10) + domain).
 * Stable across re-ingestion of the same event on the same date from the same domain.
 */
export function buildEventKey(title: string, occurredAt: string, domain: string): string {
  const normalized = [
    title.toLowerCase().trim(),
    occurredAt.slice(0, 10),
    domain.toLowerCase().trim(),
  ].join('|');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

function addHours(isoDate: string, hours: number): string {
  const d = new Date(isoDate);
  d.setTime(d.getTime() + hours * 60 * 60 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function sqliteNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Events CRUD
// ---------------------------------------------------------------------------

function rowToEvent(row: Record<string, unknown>): NormalizedEvent {
  return {
    id: String(row.id),
    eventKey: String(row.event_key),
    title: String(row.title),
    domain: String(row.domain),
    occurredAt: String(row.occurred_at),
    sourceIntelIds: parseJsonArray<string>(row.source_intel_ids as string | null),
    tags: parseJsonArray<string>(row.tags as string | null),
    status: (row.status as NormalizedEvent['status']) ?? 'active',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function upsertEvent(input: NormalizedEventInput): NormalizedEvent {
  const db = openDatabase();
  const eventKey = buildEventKey(input.title, input.occurredAt, input.domain);
  const now = sqliteNow();

  const existing = db
    .prepare(`SELECT * FROM events WHERE event_key = ? LIMIT 1`)
    .get(eventKey) as Record<string, unknown> | undefined;

  if (existing) {
    // Merge source intel IDs
    const existingIds = parseJsonArray<string>(existing.source_intel_ids as string | null);
    const newIds = input.sourceIntelIds ?? [];
    const merged = [...new Set([...existingIds, ...newIds])];

    db.prepare(`
      UPDATE events SET
        source_intel_ids = ?,
        tags = COALESCE(?, tags),
        status = ?,
        updated_at = ?
      WHERE event_key = ?
    `).run(
      toJson(merged),
      toJson(input.tags ?? null),
      input.status ?? (existing.status as string),
      now,
      eventKey
    );

    return rowToEvent(
      db.prepare(`SELECT * FROM events WHERE event_key = ? LIMIT 1`).get(eventKey) as Record<string, unknown>
    );
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO events (id, event_key, title, domain, occurred_at, source_intel_ids, tags, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    eventKey,
    input.title.trim(),
    input.domain,
    input.occurredAt,
    toJson(input.sourceIntelIds ?? []),
    toJson(input.tags ?? []),
    input.status ?? 'active',
    now,
    now
  );

  return rowToEvent(
    db.prepare(`SELECT * FROM events WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown>
  );
}

export function getEventById(id: string): NormalizedEvent | null {
  const db = openDatabase();
  const row = db.prepare(`SELECT * FROM events WHERE id = ? LIMIT 1`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEvent(row) : null;
}

export function getEventByKey(eventKey: string): NormalizedEvent | null {
  const db = openDatabase();
  const row = db
    .prepare(`SELECT * FROM events WHERE event_key = ? LIMIT 1`)
    .get(eventKey) as Record<string, unknown> | undefined;
  return row ? rowToEvent(row) : null;
}

export function listEvents(options?: {
  domain?: string;
  status?: string;
  limit?: number;
  sinceIso?: string;
}): NormalizedEvent[] {
  const db = openDatabase();
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 500);
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options?.domain) {
    clauses.push('domain = ?');
    params.push(options.domain);
  }
  if (options?.status) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  if (options?.sinceIso) {
    clauses.push('occurred_at >= ?');
    params.push(options.sinceIso);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);

  const rows = db
    .prepare(`SELECT * FROM events ${where} ORDER BY occurred_at DESC LIMIT ?`)
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map(rowToEvent);
}

// ---------------------------------------------------------------------------
// Event Thoughts CRUD
// ---------------------------------------------------------------------------

function rowToThought(row: Record<string, unknown>): EventThought {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    version: Number(row.version),
    mechanism: String(row.mechanism),
    causalChain: parseJsonArray<string>(row.causal_chain as string | null),
    impactedAssets: parseJsonArray(row.impacted_assets as string | null),
    invalidationConditions: parseJsonArray<string>(row.invalidation_conditions as string | null),
    modelVersion: row.model_version != null ? String(row.model_version) : undefined,
    createdAt: String(row.created_at),
  };
}

export function insertThought(input: EventThoughtInput): EventThought {
  const db = openDatabase();

  const lastVersion = db
    .prepare(`SELECT MAX(version) AS v FROM event_thoughts WHERE event_id = ?`)
    .get(input.eventId) as { v: number | null } | undefined;

  const version = (lastVersion?.v ?? 0) + 1;
  const id = randomUUID();
  const now = sqliteNow();

  db.prepare(`
    INSERT INTO event_thoughts (id, event_id, version, mechanism, causal_chain, impacted_assets, invalidation_conditions, model_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.eventId,
    version,
    input.mechanism,
    toJson(input.causalChain),
    toJson(input.impactedAssets),
    toJson(input.invalidationConditions),
    input.modelVersion ?? null,
    now
  );

  return rowToThought(
    db.prepare(`SELECT * FROM event_thoughts WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown>
  );
}

export function listThoughtsForEvent(eventId: string): EventThought[] {
  const db = openDatabase();
  const rows = db
    .prepare(`SELECT * FROM event_thoughts WHERE event_id = ? ORDER BY version ASC`)
    .all(eventId) as Array<Record<string, unknown>>;
  return rows.map(rowToThought);
}

export function getLatestThought(eventId: string): EventThought | null {
  const db = openDatabase();
  const row = db
    .prepare(`SELECT * FROM event_thoughts WHERE event_id = ? ORDER BY version DESC LIMIT 1`)
    .get(eventId) as Record<string, unknown> | undefined;
  return row ? rowToThought(row) : null;
}

// ---------------------------------------------------------------------------
// Event Forecasts CRUD
// ---------------------------------------------------------------------------

function rowToForecast(row: Record<string, unknown>): EventForecast {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    thoughtId: String(row.thought_id),
    asset: String(row.asset),
    domain: String(row.domain),
    direction: row.direction as EventForecast['direction'],
    horizonHours: Number(row.horizon_hours),
    confidence: Number(row.confidence),
    invalidationConditions: parseJsonArray<string>(row.invalidation_conditions as string | null),
    status: row.status as ForecastStatus,
    expiresAt: String(row.expires_at),
    resolvedAt: row.resolved_at != null ? String(row.resolved_at) : undefined,
    createdAt: String(row.created_at),
  };
}

export function insertForecast(input: EventForecastInput): EventForecast {
  const db = openDatabase();
  const id = randomUUID();
  const now = sqliteNow();
  const expiresAt = addHours(now, input.horizonHours);

  db.prepare(`
    INSERT INTO event_forecasts (id, event_id, thought_id, asset, domain, direction, horizon_hours, confidence, invalidation_conditions, status, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(
    id,
    input.eventId,
    input.thoughtId,
    input.asset.trim(),
    input.domain,
    input.direction,
    input.horizonHours,
    input.confidence,
    toJson(input.invalidationConditions ?? []),
    expiresAt,
    now
  );

  return rowToForecast(
    db.prepare(`SELECT * FROM event_forecasts WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown>
  );
}

export function updateForecastStatus(id: string, status: ForecastStatus): void {
  const db = openDatabase();
  const resolvedAt = status !== 'open' ? sqliteNow() : null;
  db.prepare(`
    UPDATE event_forecasts SET status = ?, resolved_at = ? WHERE id = ?
  `).run(status, resolvedAt, id);
}

export function listOpenForecasts(options?: { asset?: string; domain?: string }): EventForecast[] {
  const db = openDatabase();
  const clauses: string[] = ["status = 'open'"];
  const params: unknown[] = [];

  if (options?.asset) {
    clauses.push('asset = ?');
    params.push(options.asset);
  }
  if (options?.domain) {
    clauses.push('domain = ?');
    params.push(options.domain);
  }

  params.push(200);

  const rows = db
    .prepare(`SELECT * FROM event_forecasts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map(rowToForecast);
}

export function listExpiredOpenForecasts(): EventForecast[] {
  const db = openDatabase();
  const now = sqliteNow();
  const rows = db
    .prepare(`SELECT * FROM event_forecasts WHERE status = 'open' AND expires_at <= ? ORDER BY expires_at ASC`)
    .all(now) as Array<Record<string, unknown>>;
  return rows.map(rowToForecast);
}

export function listForecastsForEvent(eventId: string): EventForecast[] {
  const db = openDatabase();
  const rows = db
    .prepare(`SELECT * FROM event_forecasts WHERE event_id = ? ORDER BY created_at ASC`)
    .all(eventId) as Array<Record<string, unknown>>;
  return rows.map(rowToForecast);
}

// ---------------------------------------------------------------------------
// Event Outcomes CRUD
// ---------------------------------------------------------------------------

function rowToOutcome(row: Record<string, unknown>): EventOutcome {
  return {
    id: String(row.id),
    forecastId: String(row.forecast_id),
    eventId: String(row.event_id),
    resolutionStatus: row.resolution_status as EventOutcome['resolutionStatus'],
    resolutionNote: row.resolution_note != null ? String(row.resolution_note) : undefined,
    actualDirection: row.actual_direction as EventOutcome['actualDirection'],
    resolutionPrice: row.resolution_price != null ? Number(row.resolution_price) : undefined,
    resolvedAt: String(row.resolved_at),
    createdAt: String(row.created_at),
  };
}

export function insertOutcome(input: EventOutcomeInput): EventOutcome {
  const db = openDatabase();
  const id = randomUUID();
  const now = sqliteNow();

  db.prepare(`
    INSERT INTO event_outcomes (id, forecast_id, event_id, resolution_status, resolution_note, actual_direction, resolution_price, resolved_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.forecastId,
    input.eventId,
    input.resolutionStatus,
    input.resolutionNote ?? null,
    input.actualDirection,
    input.resolutionPrice ?? null,
    now,
    now
  );

  // Mark the forecast as resolved
  updateForecastStatus(input.forecastId, input.resolutionStatus as ForecastStatus);

  return rowToOutcome(
    db.prepare(`SELECT * FROM event_outcomes WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown>
  );
}

export function getOutcomeForForecast(forecastId: string): EventOutcome | null {
  const db = openDatabase();
  const row = db
    .prepare(`SELECT * FROM event_outcomes WHERE forecast_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(forecastId) as Record<string, unknown> | undefined;
  return row ? rowToOutcome(row) : null;
}

export function listOutcomesForEvent(eventId: string): EventOutcome[] {
  const db = openDatabase();
  const rows = db
    .prepare(`SELECT * FROM event_outcomes WHERE event_id = ? ORDER BY resolved_at DESC`)
    .all(eventId) as Array<Record<string, unknown>>;
  return rows.map(rowToOutcome);
}
