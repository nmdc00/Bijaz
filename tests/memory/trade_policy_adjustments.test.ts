import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase } from '../../src/memory/db.js';
import {
  createTradePolicyAdjustment,
  deactivateTradePolicyAdjustment,
  listTradePolicyAdjustments,
} from '../../src/memory/trade_policy_adjustments.js';

describe('trade policy adjustments', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-trade-policy-adjustments-'));
    process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');
  });

  afterEach(() => {
    if (process.env.THUFIR_DB_PATH) {
      closeDatabase(process.env.THUFIR_DB_PATH);
      rmSync(process.env.THUFIR_DB_PATH, { force: true });
      rmSync(dirname(process.env.THUFIR_DB_PATH), { recursive: true, force: true });
    }
    if (originalDbPath === undefined) {
      delete process.env.THUFIR_DB_PATH;
    } else {
      process.env.THUFIR_DB_PATH = originalDbPath;
    }
  });

  it('persists bounded policy changes and can deactivate them', () => {
    const created = createTradePolicyAdjustment({
      policyDomain: 'entry_gate',
      policyKey: 'resize_cap',
      scope: { signalClass: 'momentum_breakout', symbolClass: 'equity_proxy' },
      adjustmentType: 'downweight',
      oldValue: 1,
      newValue: 0.8,
      delta: -0.2,
      evidenceCount: 7,
      evidenceWindowStart: '2026-05-01T00:00:00.000Z',
      evidenceWindowEnd: '2026-05-14T23:59:59.000Z',
      reasonSummary: 'Late stretched probes underperform without size control.',
      confidence: 0.71,
    });

    expect(created.active).toBe(true);
    expect(created.scope?.signalClass).toBe('momentum_breakout');

    const deactivated = deactivateTradePolicyAdjustment(
      created.id,
      '2026-05-20T00:00:00.000Z'
    );
    expect(deactivated.active).toBe(false);
    expect(deactivated.expiresAt).toBe('2026-05-20T00:00:00.000Z');

    expect(
      listTradePolicyAdjustments({
        policyDomain: 'entry_gate',
        active: false,
      })
    ).toHaveLength(1);
  });
});
