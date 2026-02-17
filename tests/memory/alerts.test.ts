import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAlert,
  getAlert,
  listAlertEvents,
  markAlertSent,
  resolveAlert,
  suppressAlert,
} from '../../src/memory/alerts.js';

const previousDbPath = process.env.THUFIR_DB_PATH;

function setIsolatedDbPath(name: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-alerts-unit-'));
  process.env.THUFIR_DB_PATH = join(dir, `${name}.sqlite`);
}

afterEach(() => {
  process.env.THUFIR_DB_PATH = previousDbPath;
});

describe('alert lifecycle transitions', () => {
  it('validates supported transition path open -> suppressed -> sent -> resolved', () => {
    setIsolatedDbPath('happy-path');

    const alertId = createAlert({
      dedupeKey: 'mentat:btc:high_conviction_setup',
      source: 'mentat:btc',
      reason: 'high_conviction_setup',
      severity: 'high',
      summary: 'BTC setup crossed threshold',
      message: 'Escalation details',
    });

    suppressAlert({
      alertId,
      reasonCode: 'cooldown',
    });
    markAlertSent({
      alertId,
      reasonCode: 'delivery_success',
    });
    resolveAlert({
      alertId,
      reasonCode: 'operator_ack',
    });

    const row = getAlert(alertId);
    expect(row?.state).toBe('resolved');
    expect(row?.suppressedAt).toBeTruthy();
    expect(row?.sentAt).toBeTruthy();
    expect(row?.resolvedAt).toBeTruthy();

    const events = listAlertEvents(alertId).map((entry) => entry.eventType);
    expect(events).toEqual(['open', 'suppressed', 'sent', 'resolved']);
  });

  it('rejects invalid state regressions after send', () => {
    setIsolatedDbPath('invalid-transition');

    const alertId = createAlert({
      dedupeKey: 'mentat:eth:high_conviction_setup',
      source: 'mentat:eth',
      reason: 'high_conviction_setup',
      severity: 'critical',
      summary: 'ETH setup crossed threshold',
    });

    markAlertSent({
      alertId,
      reasonCode: 'delivery_success',
    });

    expect(() =>
      suppressAlert({
        alertId,
        reasonCode: 'dedupe',
      })
    ).toThrow('Invalid alert state transition: sent -> suppressed');
  });
});
