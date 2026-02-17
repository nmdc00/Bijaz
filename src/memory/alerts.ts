import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export type AlertState = 'open' | 'suppressed' | 'sent' | 'resolved';
export type AlertSeverity = 'info' | 'warning' | 'high' | 'critical';
export type AlertDeliveryStatus = 'retrying' | 'sent' | 'failed';
export type AlertEventType =
  | 'open'
  | 'suppressed'
  | 'sent'
  | 'resolved'
  | 'acknowledged'
  | 'delivery';

export interface AlertInput {
  dedupeKey: string;
  source: string;
  reason: string;
  severity: AlertSeverity;
  summary: string;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: string | null;
}

export interface AlertRecord {
  id: string;
  dedupeKey: string;
  source: string;
  reason: string;
  severity: AlertSeverity;
  summary: string;
  message: string | null;
  state: AlertState;
  metadata: Record<string, unknown> | null;
  occurredAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  suppressedAt: string | null;
  sentAt: string | null;
  resolvedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlertEventRecord {
  id: number;
  alertId: string;
  eventType: AlertEventType;
  fromState: AlertState | null;
  toState: AlertState | null;
  reasonCode: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface AlertDeliveryRecord {
  id: number;
  alertId: string;
  channel: string;
  status: AlertDeliveryStatus;
  attempt: number;
  providerMessageId: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const NEXT_STATE: Record<AlertState, AlertState[]> = {
  open: ['suppressed', 'sent', 'resolved'],
  suppressed: ['sent', 'resolved'],
  sent: ['resolved'],
  resolved: [],
};

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function stringifyJsonObject(value?: Record<string, unknown> | null): string | null {
  if (!value) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function normalizeIsoTimestamp(value?: string | null): string {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) {
    return new Date().toISOString();
  }
  return new Date(parsed).toISOString();
}

function mapAlertRow(row: {
  id: string;
  dedupeKey: string;
  source: string;
  reason: string;
  severity: AlertSeverity;
  summary: string;
  message: string | null;
  state: AlertState;
  metadataJson: string | null;
  occurredAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  suppressedAt: string | null;
  sentAt: string | null;
  resolvedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}): AlertRecord {
  return {
    id: row.id,
    dedupeKey: row.dedupeKey,
    source: row.source,
    reason: row.reason,
    severity: row.severity,
    summary: row.summary,
    message: row.message,
    state: row.state,
    metadata: parseJsonObject(row.metadataJson),
    occurredAt: row.occurredAt,
    acknowledgedAt: row.acknowledgedAt,
    acknowledgedBy: row.acknowledgedBy,
    suppressedAt: row.suppressedAt,
    sentAt: row.sentAt,
    resolvedAt: row.resolvedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function getAlertState(alertId: string): AlertState {
  const db = openDatabase();
  const row = db
    .prepare('SELECT state FROM alerts WHERE id = ?')
    .get(alertId) as { state?: string } | undefined;
  if (!row) {
    throw new Error(`Alert not found: ${alertId}`);
  }
  return (row.state ?? 'open') as AlertState;
}

function transitionAlertState(params: {
  alertId: string;
  nextState: AlertState;
  reasonCode?: string | null;
  payload?: Record<string, unknown> | null;
  occurredAt?: string | null;
}): void {
  const db = openDatabase();
  const now = normalizeIsoTimestamp(params.occurredAt);

  db.transaction(() => {
    const currentState = getAlertState(params.alertId);
    const allowed = NEXT_STATE[currentState];
    if (!allowed.includes(params.nextState)) {
      throw new Error(`Invalid alert state transition: ${currentState} -> ${params.nextState}`);
    }

    db.prepare(
      `
      UPDATE alerts
      SET
        state = @nextState,
        updated_at = @updatedAt,
        suppressed_at = CASE
          WHEN @nextState = 'suppressed' AND suppressed_at IS NULL THEN @updatedAt
          ELSE suppressed_at
        END,
        sent_at = CASE
          WHEN @nextState = 'sent' AND sent_at IS NULL THEN @updatedAt
          ELSE sent_at
        END,
        resolved_at = CASE
          WHEN @nextState = 'resolved' AND resolved_at IS NULL THEN @updatedAt
          ELSE resolved_at
        END,
        last_error = CASE
          WHEN @nextState = 'sent' OR @nextState = 'resolved' THEN NULL
          ELSE last_error
        END
      WHERE id = @alertId
    `
    ).run({
      alertId: params.alertId,
      nextState: params.nextState,
      updatedAt: now,
    });

    db.prepare(
      `
      INSERT INTO alert_events (
        alert_id,
        event_type,
        from_state,
        to_state,
        reason_code,
        payload_json,
        created_at
      ) VALUES (
        @alertId,
        @eventType,
        @fromState,
        @toState,
        @reasonCode,
        @payloadJson,
        @createdAt
      )
    `
    ).run({
      alertId: params.alertId,
      eventType: params.nextState,
      fromState: currentState,
      toState: params.nextState,
      reasonCode: params.reasonCode ?? null,
      payloadJson: stringifyJsonObject(params.payload ?? null),
      createdAt: now,
    });
  })();
}

export function createAlert(input: AlertInput): string {
  const db = openDatabase();
  const id = randomUUID();
  const occurredAt = input.occurredAt ? normalizeIsoTimestamp(input.occurredAt) : null;
  const createdAt = normalizeIsoTimestamp(occurredAt);

  db.transaction(() => {
    db.prepare(
      `
      INSERT INTO alerts (
        id,
        dedupe_key,
        source,
        reason,
        severity,
        summary,
        message,
        state,
        metadata_json,
        occurred_at,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @dedupeKey,
        @source,
        @reason,
        @severity,
        @summary,
        @message,
        'open',
        @metadataJson,
        @occurredAt,
        @createdAt,
        @updatedAt
      )
    `
    ).run({
      id,
      dedupeKey: input.dedupeKey,
      source: input.source,
      reason: input.reason,
      severity: input.severity,
      summary: input.summary,
      message: input.message ?? null,
      metadataJson: stringifyJsonObject(input.metadata ?? null),
      occurredAt,
      createdAt,
      updatedAt: createdAt,
    });

    db.prepare(
      `
      INSERT INTO alert_events (
        alert_id,
        event_type,
        from_state,
        to_state,
        payload_json,
        created_at
      ) VALUES (
        @alertId,
        'open',
        NULL,
        'open',
        @payloadJson,
        @createdAt
      )
    `
    ).run({
      alertId: id,
      payloadJson: stringifyJsonObject(input.metadata ?? null),
      createdAt,
    });
  })();

  return id;
}

export function suppressAlert(params: {
  alertId: string;
  reasonCode: string;
  metadata?: Record<string, unknown> | null;
  occurredAt?: string | null;
}): void {
  transitionAlertState({
    alertId: params.alertId,
    nextState: 'suppressed',
    reasonCode: params.reasonCode,
    payload: params.metadata ?? null,
    occurredAt: params.occurredAt,
  });
}

export function markAlertSent(params: {
  alertId: string;
  reasonCode?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: string | null;
}): void {
  transitionAlertState({
    alertId: params.alertId,
    nextState: 'sent',
    reasonCode: params.reasonCode ?? null,
    payload: params.metadata ?? null,
    occurredAt: params.occurredAt,
  });
}

export function resolveAlert(params: {
  alertId: string;
  reasonCode?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: string | null;
}): void {
  transitionAlertState({
    alertId: params.alertId,
    nextState: 'resolved',
    reasonCode: params.reasonCode ?? null,
    payload: params.metadata ?? null,
    occurredAt: params.occurredAt,
  });
}

export function acknowledgeAlert(params: {
  alertId: string;
  acknowledgedBy?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: string | null;
}): void {
  const db = openDatabase();
  const now = normalizeIsoTimestamp(params.occurredAt);

  db.transaction(() => {
    const existing = db.prepare('SELECT id FROM alerts WHERE id = ?').get(params.alertId) as
      | { id?: string }
      | undefined;
    if (!existing) {
      throw new Error(`Alert not found: ${params.alertId}`);
    }

    db.prepare(
      `
      UPDATE alerts
      SET acknowledged_at = @acknowledgedAt,
          acknowledged_by = @acknowledgedBy,
          updated_at = @updatedAt
      WHERE id = @id
    `
    ).run({
      id: params.alertId,
      acknowledgedAt: now,
      acknowledgedBy: params.acknowledgedBy ?? null,
      updatedAt: now,
    });

    db.prepare(
      `
      INSERT INTO alert_events (
        alert_id,
        event_type,
        from_state,
        to_state,
        payload_json,
        created_at
      ) VALUES (
        @alertId,
        'acknowledged',
        NULL,
        NULL,
        @payloadJson,
        @createdAt
      )
    `
    ).run({
      alertId: params.alertId,
      payloadJson: stringifyJsonObject(params.metadata ?? null),
      createdAt: now,
    });
  })();
}

export function recordAlertDelivery(input: {
  alertId: string;
  channel: string;
  status: AlertDeliveryStatus;
  attempt?: number;
  providerMessageId?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: string | null;
}): number {
  const db = openDatabase();
  const createdAt = normalizeIsoTimestamp(input.occurredAt);
  let rowId = 0;

  db.transaction(() => {
    const existing = db.prepare('SELECT id FROM alerts WHERE id = ?').get(input.alertId) as
      | { id?: string }
      | undefined;
    if (!existing) {
      throw new Error(`Alert not found: ${input.alertId}`);
    }

    const result = db
      .prepare(
        `
        INSERT INTO alert_deliveries (
          alert_id,
          channel,
          status,
          attempt,
          provider_message_id,
          error,
          metadata_json,
          created_at
        ) VALUES (
          @alertId,
          @channel,
          @status,
          @attempt,
          @providerMessageId,
          @error,
          @metadataJson,
          @createdAt
        )
      `
      )
      .run({
        alertId: input.alertId,
        channel: input.channel.trim().toLowerCase(),
        status: input.status,
        attempt: Math.max(1, Math.floor(input.attempt ?? 1)),
        providerMessageId: input.providerMessageId ?? null,
        error: input.error ?? null,
        metadataJson: stringifyJsonObject(input.metadata ?? null),
        createdAt,
      });
    rowId = Number(result.lastInsertRowid ?? 0);

    db.prepare(
      `
      INSERT INTO alert_events (
        alert_id,
        event_type,
        from_state,
        to_state,
        reason_code,
        payload_json,
        created_at
      ) VALUES (
        @alertId,
        'delivery',
        NULL,
        NULL,
        @reasonCode,
        @payloadJson,
        @createdAt
      )
    `
    ).run({
      alertId: input.alertId,
      reasonCode: input.status,
      payloadJson: stringifyJsonObject({
        channel: input.channel.trim().toLowerCase(),
        status: input.status,
        attempt: Math.max(1, Math.floor(input.attempt ?? 1)),
        error: input.error ?? null,
        providerMessageId: input.providerMessageId ?? null,
        ...(input.metadata ?? {}),
      }),
      createdAt,
    });

    if (input.status === 'failed' && input.error) {
      db.prepare(
        `
        UPDATE alerts
        SET last_error = @lastError, updated_at = @updatedAt
        WHERE id = @id
      `
      ).run({
        id: input.alertId,
        lastError: input.error,
        updatedAt: createdAt,
      });
    }
  })();

  return rowId;
}

export function getAlert(id: string): AlertRecord | null {
  const db = openDatabase();
  const row = db
    .prepare(
      `
      SELECT
        id,
        dedupe_key as dedupeKey,
        source,
        reason,
        severity,
        summary,
        message,
        state,
        metadata_json as metadataJson,
        occurred_at as occurredAt,
        acknowledged_at as acknowledgedAt,
        acknowledged_by as acknowledgedBy,
        suppressed_at as suppressedAt,
        sent_at as sentAt,
        resolved_at as resolvedAt,
        last_error as lastError,
        created_at as createdAt,
        updated_at as updatedAt
      FROM alerts
      WHERE id = ?
    `
    )
    .get(id) as
    | {
        id: string;
        dedupeKey: string;
        source: string;
        reason: string;
        severity: AlertSeverity;
        summary: string;
        message: string | null;
        state: AlertState;
        metadataJson: string | null;
        occurredAt: string | null;
        acknowledgedAt: string | null;
        acknowledgedBy: string | null;
        suppressedAt: string | null;
        sentAt: string | null;
        resolvedAt: string | null;
        lastError: string | null;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  if (!row) {
    return null;
  }
  return mapAlertRow(row);
}

export function listAlertEvents(alertId: string): AlertEventRecord[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
      SELECT
        id,
        alert_id as alertId,
        event_type as eventType,
        from_state as fromState,
        to_state as toState,
        reason_code as reasonCode,
        payload_json as payloadJson,
        created_at as createdAt
      FROM alert_events
      WHERE alert_id = ?
      ORDER BY id ASC
    `
    )
    .all(alertId) as Array<{
    id: number;
    alertId: string;
    eventType: AlertEventType;
    fromState: AlertState | null;
    toState: AlertState | null;
    reasonCode: string | null;
    payloadJson: string | null;
    createdAt: string;
  }>;
  return rows.map((row) => ({
    id: Number(row.id),
    alertId: row.alertId,
    eventType: row.eventType,
    fromState: row.fromState,
    toState: row.toState,
    reasonCode: row.reasonCode,
    payload: parseJsonObject(row.payloadJson),
    createdAt: row.createdAt,
  }));
}

export function listAlertDeliveries(alertId: string): AlertDeliveryRecord[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
      SELECT
        id,
        alert_id as alertId,
        channel,
        status,
        attempt,
        provider_message_id as providerMessageId,
        error,
        metadata_json as metadataJson,
        created_at as createdAt
      FROM alert_deliveries
      WHERE alert_id = ?
      ORDER BY id ASC
    `
    )
    .all(alertId) as Array<{
    id: number;
    alertId: string;
    channel: string;
    status: AlertDeliveryStatus;
    attempt: number;
    providerMessageId: string | null;
    error: string | null;
    metadataJson: string | null;
    createdAt: string;
  }>;
  return rows.map((row) => ({
    id: Number(row.id),
    alertId: row.alertId,
    channel: row.channel,
    status: row.status,
    attempt: Number(row.attempt),
    providerMessageId: row.providerMessageId,
    error: row.error,
    metadata: parseJsonObject(row.metadataJson),
    createdAt: row.createdAt,
  }));
}
