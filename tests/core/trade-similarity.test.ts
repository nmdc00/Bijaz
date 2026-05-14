import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  retrieveSimilarTradeDossiers,
  summarizeTradeSimilarity,
} from '../../src/core/trade_similarity.js';
import { buildStructuredTradeReviewSnapshot } from '../../src/core/trade_review.js';
import { closeDatabase } from '../../src/memory/db.js';
import { createLearningCase } from '../../src/memory/learning_cases.js';
import { upsertTradeDossier } from '../../src/memory/trade_dossiers.js';

describe('trade similarity retrieval', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-trade-similarity-'));
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

  it('ranks similar dossiers by signal, regime, gate history, and entry stretch with learning-case fallback', () => {
    const best = upsertTradeDossier({
      id: 'dossier-best',
      symbol: 'XYZ:COIN',
      status: 'closed',
      direction: 'long',
      strategySource: 'autonomous_originator',
      triggerReason: 'ta_alert',
      sourceTradeId: 401,
      dossier: {
        gate: {
          verdict: 'resize',
          requestedNotionalUsd: 10,
          approvedNotionalUsd: 6,
        },
        close: {
          netRealizedPnlUsd: 2.2,
        },
        counterfactuals: {
          interventionScore: 0.8,
        },
      },
      review: {
        thesisVerdict: 'correct',
        entryQuality: 'weak',
        gateInterventionQuality: 'strong',
        lessons: ['Small resized momentum probes can work in trend regimes.'],
        repeatTags: ['small_probe'],
        avoidTags: ['late_chase'],
      },
    });

    createLearningCase({
      id: 'case-best-execution',
      caseType: 'execution_quality',
      domain: 'perp',
      entityType: 'symbol',
      entityId: 'XYZ:COIN',
      comparable: false,
      sourceTradeId: 401,
      sourceDossierId: best.id,
      context: {
        signalClass: 'momentum_breakout',
        regime: 'trend',
        gateVerdict: 'resize',
        entryStretchPct: 7.7,
        symbolClass: 'equity_proxy',
      },
      qualityScores: {
        entryQuality: 'weak',
        gateInterventionQuality: 'strong',
      },
      outcome: {
        realizedPnlUsd: 2.2,
      },
    });

    upsertTradeDossier({
      id: 'dossier-mid',
      symbol: 'XYZ:MSTR',
      status: 'closed',
      direction: 'long',
      strategySource: 'autonomous_originator',
      triggerReason: 'ta_alert',
      sourceTradeId: 402,
      dossier: {
        context: {
          signalClass: 'momentum_breakout',
          regime: 'range',
          entryStretchPct: 4.2,
          symbolClass: 'equity_proxy',
        },
        gate: {
          verdict: 'reject',
        },
        close: {
          netRealizedPnlUsd: -1.1,
        },
        counterfactuals: {
          interventionScore: 0.4,
        },
      },
      review: {
        thesisVerdict: 'mixed',
        entryQuality: 'adequate',
        gateInterventionQuality: 'adequate',
        lessons: ['Range-regime equity proxies need tighter entries.'],
        repeatTags: ['trend_confirmation'],
        avoidTags: ['range_breakout_chase'],
      },
    });

    upsertTradeDossier({
      id: 'dossier-low',
      symbol: 'BTC',
      status: 'closed',
      direction: 'long',
      strategySource: 'autonomous_quant',
      triggerReason: 'event',
      sourceTradeId: 403,
      dossier: {
        context: {
          signalClass: 'mean_reversion',
          regime: 'trend',
          entryStretchPct: 1.2,
          symbolClass: 'crypto',
        },
        gate: {
          verdict: 'approve',
        },
        close: {
          netRealizedPnlUsd: 0.4,
        },
      },
      review: {
        thesisVerdict: 'unclear',
        entryQuality: 'adequate',
        lessons: ['Different signal family; low reuse value.'],
        repeatTags: ['countertrend_only'],
        avoidTags: ['proxy_confusion'],
      },
    });

    const summary = retrieveSimilarTradeDossiers({
      symbol: 'XYZ:SHOP',
      direction: 'long',
      strategySource: 'autonomous_originator',
      triggerReason: 'ta_alert',
      signalClass: 'momentum_breakout',
      regime: 'trend',
      gateVerdict: 'resize',
      entryStretchPct: 7.8,
      symbolClass: 'equity_proxy',
      limit: 3,
    });

    expect(summary.topMatches).toHaveLength(3);
    expect(summary.topMatches[0]?.dossierId).toBe('dossier-best');
    expect(summary.topMatches[0]?.matchedOn).toEqual(
      expect.arrayContaining([
        'symbol_class',
        'signal_class',
        'trigger_reason',
        'regime',
        'gate_verdict',
        'entry_stretch',
      ])
    );
    expect(summary.stats.gateVerdictCounts).toEqual({
      resize: 1,
      reject: 1,
      approve: 1,
    });
    expect(summary.repeatTags).toContain('small_probe');
    expect(summary.avoidTags).toContain('late_chase');
    expect(summary.recommendation).toBe('size_reduction');
  });

  it('builds compact summary and normalized structured review outputs', () => {
    const dossier = upsertTradeDossier({
      id: 'dossier-review',
      symbol: 'XYZ:COIN',
      status: 'closed',
      direction: 'long',
      sourceTradeId: 501,
      dossier: {
        close: {
          netRealizedPnlUsd: 1.4,
        },
      },
      review: {
        thesisVerdict: 'correct',
        entryQuality: 'weak',
        gateInterventionQuality: 'strong',
        mainFailureMode: 'Late entry',
        lessons: ['Keep the gate resize for stretched probes.'],
        repeatTags: ['small_probe', 'small_probe'],
        avoidTags: ['late_chase'],
      },
    });

    const learningCase = createLearningCase({
      id: 'case-review-execution',
      caseType: 'execution_quality',
      domain: 'perp',
      entityType: 'symbol',
      entityId: 'XYZ:COIN',
      comparable: false,
      sourceTradeId: 501,
      sourceDossierId: dossier.id,
      qualityScores: {
        sizingQuality: 'adequate',
        leverageQuality: 'adequate',
        exitQuality: 'poor',
        contextFit: 'adequate',
      },
    });

    const review = buildStructuredTradeReviewSnapshot(dossier, [learningCase]);
    expect(review.sizingQuality).toBe('adequate');
    expect(review.leverageQuality).toBe('adequate');
    expect(review.exitQuality).toBe('poor');
    expect(review.lessons).toEqual(
      expect.arrayContaining([
        'Keep the gate resize for stretched probes.',
        'Entry timing was the weak point; treat similar setups as lower-conviction.',
        'Gate intervention helped and should influence similar future sizing decisions.',
      ])
    );
    expect(review.repeatTags).toEqual(['small_probe']);

    const summary = summarizeTradeSimilarity([
      {
        dossierId: dossier.id,
        symbol: dossier.symbol,
        direction: dossier.direction,
        triggerReason: 'ta_alert',
        similarityScore: 88,
        matchedOn: ['signal_class', 'gate_verdict'],
        symbolClass: 'equity_proxy',
        signalClass: 'momentum_breakout',
        regime: 'trend',
        gateVerdict: 'resize',
        entryStretchPct: 7.8,
        realizedPnlUsd: 1.4,
        interventionScore: 0.9,
        thesisVerdict: review.thesisVerdict,
        review,
      },
    ]);

    expect(summary.stats.sampleSize).toBe(1);
    expect(summary.stats.winRate).toBe(1);
    expect(summary.topLessons[0]).toBe('Entry timing was the weak point; treat similar setups as lower-conviction.');
    expect(summary.recommendation).toBe('size_reduction');
  });
});
