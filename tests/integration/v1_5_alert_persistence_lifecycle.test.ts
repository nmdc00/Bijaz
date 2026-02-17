import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createAlert,
  getAlert,
  listAlertDeliveries,
  listAlertEvents,
  markAlertSent,
  recordAlertDelivery,
  resolveAlert,
  suppressAlert,
} from '../../src/memory/alerts.js';
import { openDatabase } from '../../src/memory/db.js';
import { EscalationPolicyEngine } from '../../src/gateway/escalation.js';

const previousDbPath = process.env.THUFIR_DB_PATH;

function createTempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-v15-alerts-'));
  return join(dir, `${name}.sqlite`);
}

afterEach(() => {
  process.env.THUFIR_DB_PATH = previousDbPath;
});

describe('v1.5 alert persistence lifecycle integration', () => {
  it('migrates legacy databases to include alert lifecycle tables', () => {
    const dbPath = createTempDbPath('migration');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE predictions (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        market_title TEXT NOT NULL
      );
    `);
    legacy.close();

    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase();

    const requiredTables = ['alerts', 'alert_events', 'alert_deliveries'];
    for (const table of requiredTables) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table) as { name?: string } | undefined;
      expect(row?.name).toBe(table);
    }

    const alertColumns = db.prepare("PRAGMA table_info('alerts')").all() as Array<{ name: string }>;
    const names = alertColumns.map((column) => column.name);
    expect(names).toContain('state');
    expect(names).toContain('suppressed_at');
    expect(names).toContain('sent_at');
    expect(names).toContain('resolved_at');
  });

  it('persists end-to-end lifecycle records for sent and suppressed decisions', () => {
    process.env.THUFIR_DB_PATH = createTempDbPath('lifecycle');
    openDatabase();

    const policy = new EscalationPolicyEngine(
      {
        enabled: true,
        channels: ['telegram'],
        dedupeWindowSeconds: 300,
        cooldownSeconds: 0,
      },
      () => 1_700_000_000_000
    );

    const baseEvent = {
      source: 'mentat:default',
      reason: 'high_conviction_setup' as const,
      severity: 'critical' as const,
      dedupeKey: 'mentat:default:high_conviction_setup',
      summary: 'Fragility breach detected',
      message: 'Mechanical fallback summary',
    };

    const firstDecision = policy.evaluate(baseEvent);
    expect(firstDecision.shouldSend).toBe(true);

    const sentAlertId = createAlert({
      dedupeKey: firstDecision.dedupeKey,
      source: baseEvent.source,
      reason: baseEvent.reason,
      severity: baseEvent.severity,
      summary: baseEvent.summary,
      message: firstDecision.message,
    });
    recordAlertDelivery({
      alertId: sentAlertId,
      channel: 'telegram',
      status: 'sent',
      providerMessageId: 'msg-1',
    });
    markAlertSent({
      alertId: sentAlertId,
      reasonCode: 'delivery_success',
    });

    const secondDecision = policy.evaluate({
      ...baseEvent,
      message: 'Duplicate within dedupe window',
    });
    expect(secondDecision.shouldSend).toBe(false);
    expect(secondDecision.suppressionReason).toBe('dedupe');

    const suppressedAlertId = createAlert({
      dedupeKey: secondDecision.dedupeKey,
      source: baseEvent.source,
      reason: baseEvent.reason,
      severity: 'high',
      summary: 'Duplicate fragility breach',
      message: secondDecision.message,
    });
    suppressAlert({
      alertId: suppressedAlertId,
      reasonCode: secondDecision.suppressionReason ?? 'unknown',
    });

    resolveAlert({
      alertId: sentAlertId,
      reasonCode: 'operator_ack',
    });

    const sentRow = getAlert(sentAlertId);
    const suppressedRow = getAlert(suppressedAlertId);
    expect(sentRow?.state).toBe('resolved');
    expect(suppressedRow?.state).toBe('suppressed');
    expect(sentRow?.sentAt).toBeTruthy();
    expect(sentRow?.resolvedAt).toBeTruthy();

    const sentEvents = listAlertEvents(sentAlertId).map((entry) => entry.eventType);
    expect(sentEvents).toEqual(['open', 'delivery', 'sent', 'resolved']);

    const suppressedEvents = listAlertEvents(suppressedAlertId).map((entry) => entry.eventType);
    expect(suppressedEvents).toEqual(['open', 'suppressed']);

    const sentDeliveries = listAlertDeliveries(sentAlertId);
    const suppressedDeliveries = listAlertDeliveries(suppressedAlertId);
    expect(sentDeliveries).toHaveLength(1);
    expect(sentDeliveries[0]?.status).toBe('sent');
    expect(suppressedDeliveries).toHaveLength(0);
  });
});
