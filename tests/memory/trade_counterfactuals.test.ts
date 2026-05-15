import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase } from '../../src/memory/db.js';
import {
  createTradeCounterfactual,
  listTradeCounterfactuals,
} from '../../src/memory/trade_counterfactuals.js';

describe('trade counterfactuals', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-trade-counterfactuals-'));
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

  it('stores typed counterfactual rows with explicit valuation fields', () => {
    const created = createTradeCounterfactual({
      dossierId: 'dossier-401',
      counterfactualType: 'delay_entry',
      baselineKind: 'gate_resize',
      summary: 'Waiting for the next pullback improved fill quality.',
      score: 0.74,
      estimatedNetPnlUsd: 3.4,
      estimatedRMultiple: 1.2,
      valueAddUsd: 2.1,
      confidence: 0.63,
      inputs: { delayMinutes: 12, trigger: 'reclaim_vwap' },
      result: { alternateEntryPrice: 201.15, realizedPnlUsd: 3.4 },
    });

    expect(created.counterfactualType).toBe('delay_entry');
    expect(created.inputs).toEqual({ delayMinutes: 12, trigger: 'reclaim_vwap' });
    expect(created.result?.alternateEntryPrice).toBe(201.15);

    const listed = listTradeCounterfactuals({ dossierId: 'dossier-401' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.valueAddUsd).toBe(2.1);
  });
});
