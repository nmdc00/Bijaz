import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordOutcome } from '../../src/memory/calibration.js';
import { openDatabase } from '../../src/memory/db.js';
import { setLearningRuntimeContext } from '../../src/memory/learning_observability.js';
import { createPrediction } from '../../src/memory/predictions.js';

describe('learning observability', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-learning-observability-'));
    process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');
    openDatabase();
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

  it('records runtime-tagged shadow audits and tags learning event notes', () => {
    const db = openDatabase();
    setLearningRuntimeContext({ runId: 'paper-reset-2026-05-13', policyVersion: 'weights-v1' }, db);

    const predictionId = createPrediction({
      marketId: 'perp:BTC',
      marketTitle: 'BTC observability test',
      predictedOutcome: 'YES',
      predictedProbability: 0.7,
      modelProbability: 0.7,
      marketProbability: 0.45,
      domain: 'perp',
      learningComparable: true,
      signalScores: {
        technical: 0.9,
        news: 0.2,
        onChain: 0.1,
      },
      signalWeightsSnapshot: {
        technical: 0.5,
        news: 0.3,
        onChain: 0.2,
      },
    });

    recordOutcome({ id: predictionId, outcome: 'YES', outcomeBasis: 'final', pnl: 5 });

    const audit = db.prepare(
      `
        SELECT run_id AS runId,
               policy_version AS policyVersion,
               changed_vs_default AS changedVsDefault,
               changed_after_update AS changedAfterUpdate,
               decision_confidence AS decisionConfidence,
               active_confidence_after AS activeConfidenceAfter
        FROM learning_signal_audits
        ORDER BY id DESC
        LIMIT 1
      `
    ).get() as {
      runId: string;
      policyVersion: string;
      changedVsDefault: number;
      changedAfterUpdate: number;
      decisionConfidence: number;
      activeConfidenceAfter: number;
    };

    expect(audit.runId).toBe('paper-reset-2026-05-13');
    expect(audit.policyVersion).toBe('weights-v1');
    expect(audit.changedVsDefault).toBe(0);
    expect(audit.changedAfterUpdate).toBe(1);
    expect(audit.activeConfidenceAfter).toBeGreaterThan(audit.decisionConfidence);

    const learningEvent = db.prepare(
      `
        SELECT notes
        FROM learning_events
        ORDER BY id DESC
        LIMIT 1
      `
    ).get() as { notes: string };
    const notes = JSON.parse(learningEvent.notes) as Record<string, unknown>;
    expect(notes.runId).toBe('paper-reset-2026-05-13');
    expect(notes.policyVersion).toBe('weights-v1');
  });
});
