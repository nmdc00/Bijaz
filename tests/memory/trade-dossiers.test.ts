import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/memory/db.js';
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
      sourceHypothesisId: 'hyp-101',
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
      retrieval: {
        retrievedCases: [{ dossierId: 'prior-17', score: 0.81 }],
      },
      policyTrace: {
        activeAdjustments: [{ policyKey: 'entry.resize_cap', delta: -0.2 }],
      },
    });

    expect(closed.status).toBe('closed');
    expect(closed.sourceHypothesisId).toBe('hyp-101');
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
    expect(closed.retrieval?.retrievedCases).toEqual([{ dossierId: 'prior-17', score: 0.81 }]);
    expect(closed.policyTrace?.activeAdjustments).toEqual([
      { policyKey: 'entry.resize_cap', delta: -0.2 },
    ]);

    const dossiers = listTradeDossiers({ symbol: 'XYZ:COIN', limit: 5 });
    expect(dossiers).toHaveLength(1);
    expect(dossiers[0]?.id).toBe(opened.id);
  });

  it('repairs legacy dossier tables with v2.2 trace columns', () => {
    const dbPath = process.env.THUFIR_DB_PATH as string;
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE trade_dossiers (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        status TEXT NOT NULL,
        direction TEXT,
        strategy_source TEXT,
        execution_mode TEXT,
        source_trade_id INTEGER,
        source_prediction_id TEXT,
        proposal_record_id INTEGER,
        trigger_reason TEXT,
        opened_at TEXT,
        closed_at TEXT,
        dossier_payload TEXT,
        review_payload TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT
      )
    `);
    raw.close();

    const db = openDatabase(dbPath);
    const columns = db.prepare("PRAGMA table_info('trade_dossiers')").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));

    expect(columnNames.has('source_hypothesis_id')).toBe(true);
    expect(columnNames.has('retrieval_payload')).toBe(true);
    expect(columnNames.has('policy_trace_payload')).toBe(true);
  });
});
