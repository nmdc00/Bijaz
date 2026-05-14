import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listTradeDossiers, upsertTradeDossier } from '../../src/memory/trade_dossiers.js';

describe('trade dossiers', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-trade-dossiers-'));
    process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');
  });

  afterEach(() => {
    if (process.env.THUFIR_DB_PATH) {
      rmSync(process.env.THUFIR_DB_PATH, { force: true });
      rmSync(dirname(process.env.THUFIR_DB_PATH), { recursive: true, force: true });
    }
    if (originalDbPath === undefined) {
      delete process.env.THUFIR_DB_PATH;
    } else {
      process.env.THUFIR_DB_PATH = originalDbPath;
    }
  });

  it('creates and closes a canonical dossier while preserving prior payload sections', () => {
    const opened = upsertTradeDossier({
      symbol: 'XYZ:COIN',
      status: 'open',
      direction: 'long',
      strategySource: 'autonomous_originator',
      executionMode: 'paper',
      sourceTradeId: 101,
      sourcePredictionId: 'pred-101',
      triggerReason: 'ta_alert',
      openedAt: '2026-05-14T16:42:07.110Z',
      dossier: {
        thesis: {
          thesisText: 'Crypto beta continuation via COIN',
          invalidationPrice: 214,
        },
        gate: {
          verdict: 'resize',
          requestedNotionalUsd: 10,
          approvedNotionalUsd: 6,
        },
      },
    });

    const closed = upsertTradeDossier({
      id: opened.id,
      symbol: 'XYZ:COIN',
      status: 'closed',
      closedAt: '2026-05-14T17:10:00.000Z',
      dossier: {
        close: {
          exitMode: 'take_profit',
          netRealizedPnlUsd: 1.25,
        },
      },
      review: {
        thesisVerdict: 'correct',
        entryQuality: 'weak',
        lessons: ['Gate resize should remain part of the lesson.'],
      },
    });

    expect(closed.status).toBe('closed');
    expect(closed.dossier?.thesis).toEqual(
      expect.objectContaining({
        thesisText: 'Crypto beta continuation via COIN',
        invalidationPrice: 214,
      })
    );
    expect(closed.dossier?.gate).toEqual(
      expect.objectContaining({
        verdict: 'resize',
        requestedNotionalUsd: 10,
        approvedNotionalUsd: 6,
      })
    );
    expect(closed.dossier?.close).toEqual(
      expect.objectContaining({
        exitMode: 'take_profit',
        netRealizedPnlUsd: 1.25,
      })
    );
    expect(closed.review?.entryQuality).toBe('weak');

    const dossiers = listTradeDossiers({ symbol: 'XYZ:COIN', limit: 5 });
    expect(dossiers).toHaveLength(1);
    expect(dossiers[0]?.id).toBe(opened.id);
  });
});
