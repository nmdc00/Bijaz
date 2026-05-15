import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase } from '../../src/memory/db.js';
import {
  getTradeSimilarityFeatures,
  listTradeSimilarityFeatures,
  upsertTradeSimilarityFeatures,
} from '../../src/memory/trade_similarity_features.js';

describe('trade similarity features', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-trade-similarity-features-'));
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

  it('upserts typed retrieval features without reparsing dossier payloads', () => {
    upsertTradeSimilarityFeatures({
      dossierId: 'dossier-501',
      symbol: 'xyz:coin',
      signalClass: 'momentum_breakout',
      tradeArchetype: 'intraday',
      marketRegime: 'trend',
      gateVerdict: 'resize',
      opportunityRank: 2,
      sourceCount: 4,
      conflictingEvidenceCount: 1,
      regimeTransitionFlag: true,
    });

    const updated = upsertTradeSimilarityFeatures({
      dossierId: 'dossier-501',
      symbol: 'xyz:coin',
      signalClass: 'momentum_breakout',
      tradeArchetype: 'intraday',
      marketRegime: 'trend',
      gateVerdict: 'approve',
      executionConditionBucket: 'liquid_open',
      sessionBucket: 'us_open',
    });

    expect(updated.symbol).toBe('XYZ:COIN');
    expect(updated.gateVerdict).toBe('approve');
    expect(updated.regimeTransitionFlag).toBe(false);
    expect(getTradeSimilarityFeatures('dossier-501').executionConditionBucket).toBe('liquid_open');

    const listed = listTradeSimilarityFeatures({
      symbol: 'XYZ:COIN',
      gateVerdict: 'approve',
    });
    expect(listed).toHaveLength(1);
  });
});
