import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/memory/db.js';
import { storeDecisionArtifact } from '../../src/memory/decision_artifacts.js';
import { recordEntryGateDecision } from '../../src/memory/llm_entry_gate_log.js';
import { placePaperPerpOrder } from '../../src/memory/paper_perps.js';
import { recordPerpTradeJournal } from '../../src/memory/perp_trade_journal.js';
import { recordOutcome } from '../../src/memory/calibration.js';
import { createPrediction } from '../../src/memory/predictions.js';
import { setLearningRuntimeContext } from '../../src/memory/learning_observability.js';
import {
  buildDashboardApiPayload,
  handleDashboardApiRequest,
  parseDashboardFilters,
} from '../../src/gateway/dashboard_api.js';

describe('dashboard api filters', () => {
  it('defaults to combined/all when query values are absent or invalid', () => {
    const url = new URL('http://localhost/api/dashboard?mode=bad&timeframe=weird');
    const filters = parseDashboardFilters(url);
    expect(filters).toEqual({
      mode: 'combined',
      timeframe: 'all',
      period: null,
      from: null,
      to: null,
    });
  });

  it('normalizes day timeframe into explicit UTC start/end bounds', () => {
    const now = new Date('2026-02-25T18:31:00.000Z');
    const url = new URL('http://localhost/api/dashboard?mode=paper&timeframe=day');
    const filters = parseDashboardFilters(url, now);
    expect(filters.mode).toBe('paper');
    expect(filters.timeframe).toBe('day');
    expect(filters.from).toBe('2026-02-25T00:00:00.000Z');
    expect(filters.to).toBe('2026-02-25T18:31:00.000Z');
  });
});

describe('dashboard api payload', () => {
  let dbPath: string | null = null;
  let dbDir: string | null = null;
  const originalDbPath = process.env.THUFIR_DB_PATH;

  afterEach(() => {
    process.env.THUFIR_DB_PATH = originalDbPath;
    if (dbPath) {
      rmSync(dbPath, { force: true });
      dbPath = null;
    }
    if (dbDir) {
      rmSync(dbDir, { recursive: true, force: true });
      dbDir = null;
    }
  });

  it('returns stable empty-state sections for a fresh db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-api-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    const db = openDatabase(dbPath);
    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'combined',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.meta.mode).toBe('combined');
    expect(payload.sections.equityCurve.points.length).toBe(1);
    expect(payload.sections.equityCurve.summary.startEquity).not.toBeNull();
    expect(payload.sections.openPositions.rows).toEqual([]);
    expect(payload.sections.tradeLog.rows).toEqual([]);
    expect(payload.sections.promotionGates.rows).toEqual([]);
    expect(payload.sections.performanceBreakdown.bySignalClass).toEqual([]);
    expect(payload.sections.predictionAccuracy.global).toHaveLength(5);
    expect(payload.sections.predictionAccuracy.global.every((row) => row.accuracy === null)).toBe(true);
    expect(payload.sections.predictionAccuracy.totalFinalPredictions).toBe(0);
    expect(payload.sections.learningAudit.comparable.totalCaseCount).toBe(0);
    expect(payload.sections.learningAudit.execution.totalCaseCount).toBe(0);
    expect(payload.sections.learningAudit.exclusions.totalCaseCount).toBe(0);
    expect(payload.sections.learningAudit.policyOutputs).toEqual([]);
    expect(payload.sections.learningObservability.runtimeContext.runId).toBe('default');
    expect(payload.sections.learningObservability.runtimeContext.policyVersion).toBe('default');
    expect(payload.sections.learningObservability.totalShadowAudits).toBe(0);
    expect(payload.sections.learningObservability.runSummaries).toEqual([]);
    expect(payload.sections.gateAttribution.entryGate.verdictCounts).toEqual({
      approve: 0,
      reject: 0,
      resize: 0,
    });
    expect(payload.sections.gateAttribution.entryGate.reasonCounts).toEqual([]);
    expect(payload.sections.gateAttribution.journal.outcomeCounts).toEqual({
      executed: 0,
      failed: 0,
      blocked: 0,
    });
    expect(typeof payload.meta.recordCounts.perpTrades).toBe('number');
    expect(typeof payload.meta.recordCounts.journals).toBe('number');
  });

  it('builds gate attribution metrics from structured gate logs and trade journals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-gate-attribution-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    recordEntryGateDecision({
      symbol: 'BTC',
      side: 'buy',
      notionalUsd: 50,
      verdict: 'reject',
      reasoning: 'Opposite-side position already open on this symbol. Cannot open conflicting trade.',
      reasonCode: 'book_conflict',
      usedFallback: false,
      signalClass: 'momentum_breakout',
      regime: 'trending',
      session: 'us',
      edge: 0.08,
    });
    recordEntryGateDecision({
      symbol: 'ETH',
      side: 'sell',
      notionalUsd: 40,
      verdict: 'resize',
      reasoning: 'Reduce size for risk',
      reasonCode: 'size_downshift',
      adjustedSizeUsd: 25,
      usedFallback: false,
      signalClass: 'mean_reversion',
      regime: 'choppy',
      session: 'us',
      edge: 0.05,
      suggestedLeverage: 2,
    });

    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      execution_mode: 'paper',
      symbol: 'BTC',
      side: 'buy',
      signalClass: 'momentum_breakout',
      outcome: 'blocked',
      reasoning: 'LLM entry gate rejected: Opposite-side position already open',
      error: 'Opposite-side position already open',
      policyReasonCode: 'policy.decision_quality',
      policyReason: 'quality.segment.downweight: score below threshold',
      policySizeMultiplier: 0.5,
      entryGateVerdict: 'reject',
      entryGateReasonCode: 'book_conflict',
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      execution_mode: 'paper',
      symbol: 'ETH',
      side: 'sell',
      signalClass: 'mean_reversion',
      outcome: 'executed',
      reasoning: 'Executed after resize',
      policyReasonCode: 'policy.decision_quality',
      policyReason: 'quality.segment.downweight: score below threshold',
      policySizeMultiplier: 0.5,
      entryGateVerdict: 'resize',
      entryGateReasonCode: 'size_downshift',
    });

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.gateAttribution.entryGate.verdictCounts).toEqual({
      approve: 0,
      reject: 1,
      resize: 1,
    });
    expect(payload.sections.gateAttribution.entryGate.reasonCounts).toEqual([
      { reasonCode: 'book_conflict', count: 1 },
      { reasonCode: 'size_downshift', count: 1 },
    ]);
    expect(payload.sections.gateAttribution.entryGate.recentDecisions[0]).toMatchObject({
      symbol: 'ETH',
      verdict: 'resize',
      reasonCode: 'size_downshift',
      adjustedSizeUsd: 25,
      suggestedLeverage: 2,
    });
    expect(payload.sections.gateAttribution.journal.outcomeCounts).toEqual({
      executed: 1,
      failed: 0,
      blocked: 1,
    });
    expect(payload.sections.gateAttribution.journal.blockedReasons[0]?.reason).toContain('LLM entry gate rejected');
    expect(
      payload.sections.gateAttribution.journal.recentPolicyAdjustments.some((row) =>
        row.symbol === 'ETH' &&
        row.policyReasonCode === 'policy.decision_quality' &&
        row.policySizeMultiplier === 0.5 &&
        row.entryGateVerdict === 'resize' &&
        row.entryGateReasonCode === 'size_downshift'
      )
    ).toBe(true);
  });

  it('includes prediction-accuracy windows once final comparable rows exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-pred-accuracy-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    for (let index = 0; index < 20; index += 1) {
      const id = createPrediction({
        marketId: `market-${index}`,
        marketTitle: `Market ${index}`,
        predictedOutcome: 'YES',
        predictedProbability: 0.65,
        modelProbability: 0.65,
        marketProbability: 0.55,
        domain: 'binary',
        executed: true,
      });
      recordOutcome({
        id,
        outcome: index % 5 === 0 ? 'NO' : 'YES',
        outcomeBasis: 'final',
        pnl: index % 5 === 0 ? -4 : 6,
      });
    }

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'combined',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.predictionAccuracy.totalFinalPredictions).toBe(20);
    expect(payload.sections.predictionAccuracy.global.find((row) => row.windowSize === 20)?.accuracy).not.toBeNull();
    expect(payload.sections.predictionAccuracy.byDomain.binary?.find((row) => row.windowSize === 20)?.brierDelta).not.toBeNull();
    expect(payload.sections.learningAudit.comparable.totalCaseCount).toBe(20);
    expect(payload.sections.learningAudit.comparable.byDomain).toEqual([{ domain: 'binary', count: 20 }]);
  });

  it('surfaces learning observability run summaries and recent shadow audits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-learning-observability-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    setLearningRuntimeContext({ runId: 'paper-reset-2026-05-13', policyVersion: 'weights-v2' }, db);
    const predictionId = createPrediction({
      marketId: 'perp:BTC',
      marketTitle: 'BTC dashboard observability',
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

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'combined',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.learningObservability.runtimeContext.runId).toBe('paper-reset-2026-05-13');
    expect(payload.sections.learningObservability.runtimeContext.policyVersion).toBe('weights-v2');
    expect(payload.sections.learningObservability.totalShadowAudits).toBe(1);
    expect(payload.sections.learningObservability.activeWeights.some((row) => row.domain === 'perp')).toBe(true);
    expect(payload.sections.learningObservability.runSummaries).toEqual([
      expect.objectContaining({
        runId: 'paper-reset-2026-05-13',
        policyVersion: 'weights-v2',
        eventCount: 1,
        changedVsDefaultCount: 0,
        changedAfterUpdateCount: 1,
      }),
    ]);
    expect(payload.sections.learningObservability.recentAudits).toEqual([
      expect.objectContaining({
        domain: 'perp',
        runId: 'paper-reset-2026-05-13',
        policyVersion: 'weights-v2',
        changedVsDefault: false,
        changedAfterUpdate: true,
      }),
    ]);
  });

  it('derives learning audit surfaces from legacy comparable rows, journals, and policy state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-learning-audit-fallback-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    for (let index = 0; index < 20; index += 1) {
      const id = createPrediction({
        marketId: `binary-${index}`,
        marketTitle: `Binary ${index}`,
        predictedOutcome: 'YES',
        predictedProbability: 0.65,
        modelProbability: 0.65,
        marketProbability: 0.55,
        domain: 'binary',
        executed: true,
      });
      recordOutcome({
        id,
        outcome: index < 15 ? 'NO' : 'YES',
        outcomeBasis: 'final',
        pnl: index < 15 ? -5 : 5,
      });
    }

    createPrediction({
      marketId: 'perp-btc',
      marketTitle: 'BTC perp short',
      predictedOutcome: 'NO',
      predictedProbability: 0.58,
      modelProbability: 0.58,
      domain: 'perp',
      learningComparable: false,
      executed: true,
    });
    createPrediction({
      marketId: 'event-estimated',
      marketTitle: 'Estimated event',
      predictedOutcome: 'YES',
      predictedProbability: 0.52,
      modelProbability: 0.52,
      marketProbability: 0.49,
      domain: 'events',
      learningComparable: false,
      executed: true,
    });

    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'BTC',
      outcome: 'executed',
      capturedR: 1.1,
      marketRegime: 'trending',
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'ETH',
      outcome: 'executed',
      capturedR: -0.4,
      marketRegime: 'choppy',
    });

    db.exec(`
      DROP TABLE IF EXISTS autonomy_policy_state;
      CREATE TABLE autonomy_policy_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        updated_at TEXT
      );
    `);
    db.prepare(
      `
        INSERT INTO autonomy_policy_state (payload, updated_at)
        VALUES (?, ?)
      `
    ).run(
      JSON.stringify({
        observationOnlyUntilMs: Date.now() + 120_000,
        leverageCapOverride: 1.5,
        reason: 'quality.segment.downweight: score soft-failed',
      }),
      '2026-05-05T12:00:00.000Z'
    );

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'combined',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.learningAudit.comparable.totalCaseCount).toBe(20);
    expect(payload.sections.learningAudit.execution.totalCaseCount).toBe(2);
    expect(payload.sections.learningAudit.execution.byDomain).toEqual([{ domain: 'perp', count: 2 }]);
    expect(payload.sections.learningAudit.exclusions.byReason).toEqual([
      { reason: 'outcome_not_final', count: 1 },
      { reason: 'perp_without_real_comparator', count: 1 },
    ]);
    expect(payload.sections.learningAudit.policyOutputs.some((row) => row.sourceTrack === 'comparable_forecast' && row.action === 'resize' && row.scope === 'binary')).toBe(true);
    expect(payload.sections.learningAudit.policyOutputs.some((row) => row.sourceTrack === 'combined' && row.action === 'suppress')).toBe(true);
    expect(payload.sections.learningAudit.policyOutputs.some((row) => row.sourceTrack === 'execution_quality' && row.reason === 'leverage_cap_override')).toBe(true);
  });

  it('prefers canonical learning_cases audit rows when the foundation table exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-learning-cases-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS learning_cases (
        id TEXT PRIMARY KEY,
        case_type TEXT NOT NULL,
        domain TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        comparable INTEGER NOT NULL,
        comparator_kind TEXT,
        source_prediction_id TEXT,
        source_trade_id INTEGER,
        source_artifact_id INTEGER,
        belief_payload TEXT,
        baseline_payload TEXT,
        context_payload TEXT,
        action_payload TEXT,
        outcome_payload TEXT,
        quality_payload TEXT,
        policy_input_payload TEXT,
        exclusion_reason TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT
      );
    `);
    db.exec(`DELETE FROM learning_cases;`);

    db.prepare(
      `
        INSERT INTO learning_cases (
          id, case_type, domain, entity_type, entity_id, comparable, policy_input_payload, exclusion_reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      'cf-1',
      'comparable_forecast',
      'binary',
      'market',
      'm1',
      1,
      JSON.stringify({ sourceTrack: 'comparable_forecast', action: 'resize', sizeMultiplier: 0.5, reason: 'domain_calibration_degrading', scope: 'binary' }),
      null,
      '2026-05-05T13:00:00.000Z'
    );
    db.prepare(
      `
        INSERT INTO learning_cases (
          id, case_type, domain, entity_type, entity_id, comparable, policy_input_payload, exclusion_reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      'eq-1',
      'execution_quality',
      'perp',
      'trade',
      't1',
      0,
      JSON.stringify({ sourceTrack: 'execution_quality', blocked: true, reason: 'quality.segment.block', scope: 'perp' }),
      'perp_without_real_comparator',
      '2026-05-05T13:05:00.000Z'
    );

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'combined',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.learningAudit.comparable.totalCaseCount).toBe(1);
    expect(payload.sections.learningAudit.execution.totalCaseCount).toBe(1);
    expect(payload.sections.learningAudit.exclusions.totalCaseCount).toBe(1);
    expect(payload.sections.learningAudit.policyOutputs).toEqual([
      expect.objectContaining({
        sourceTrack: 'execution_quality',
        action: 'block',
        scope: 'perp',
        reason: 'quality.segment.block',
      }),
      expect.objectContaining({
        sourceTrack: 'comparable_forecast',
        action: 'resize',
        scope: 'binary',
        sizeMultiplier: 0.5,
      }),
    ]);
  });

  it('computes equity curve points and summary from paper fills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-equity-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    placePaperPerpOrder(
      { symbol: 'BTC', side: 'buy', size: 1, orderType: 'market', markPrice: 100 },
      { initialCashUsdc: 200 }
    );
    placePaperPerpOrder(
      { symbol: 'BTC', side: 'sell', size: 1, orderType: 'market', markPrice: 110, reduceOnly: true },
      { initialCashUsdc: 200 }
    );

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.equityCurve.points.length).toBeGreaterThanOrEqual(2);
    const endEquity = payload.sections.equityCurve.summary.endEquity;
    expect(endEquity).not.toBeNull();
    expect(Number(endEquity)).toBeGreaterThan(200);
    expect(Number(payload.sections.equityCurve.summary.returnPct)).toBeGreaterThan(0);
  });

  it('returns open paper positions with current mark and unrealized pnl summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-open-pos-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    placePaperPerpOrder(
      { symbol: 'BTC', side: 'buy', size: 2, orderType: 'market', markPrice: 100 },
      { initialCashUsdc: 200 }
    );
    placePaperPerpOrder(
      { symbol: 'BTC', side: 'sell', size: 1, orderType: 'market', markPrice: 110, reduceOnly: true },
      { initialCashUsdc: 200 }
    );

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.openPositions.rows.length).toBe(1);
    const row = payload.sections.openPositions.rows[0]!;
    expect(row.symbol).toBe('BTC');
    expect(row.side).toBe('long');
    expect(row.entryPrice).toBeCloseTo(100.05, 6);
    expect(row.currentPrice).toBe(110);
    expect(row.unrealizedPnlUsd).toBeCloseTo(9.95, 6);
    expect(payload.sections.openPositions.summary.longCount).toBe(1);
    expect(payload.sections.openPositions.summary.shortCount).toBe(0);
    expect(payload.sections.openPositions.summary.totalUnrealizedPnlUsd).toBeCloseTo(9.95, 6);
  });

  it('marks paper equity to the same current mids as open positions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-paper-equity-mark-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    placePaperPerpOrder(
      { symbol: 'BTC', side: 'buy', size: 2, orderType: 'market', markPrice: 100 },
      { initialCashUsdc: 200 }
    );
    placePaperPerpOrder(
      { symbol: 'BTC', side: 'sell', size: 1, orderType: 'market', markPrice: 110, reduceOnly: true },
      { initialCashUsdc: 200 }
    );

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
      mids: { BTC: 120 },
    });

    const endPoint = payload.sections.equityCurve.points[payload.sections.equityCurve.points.length - 1]!;
    expect(payload.sections.openPositions.rows[0]?.currentPrice).toBe(120);
    expect(payload.sections.openPositions.summary.totalUnrealizedPnlUsd).toBeCloseTo(19.95, 6);
    expect(endPoint.unrealizedPnl).toBeCloseTo(19.95, 6);
    expect(payload.sections.equityCurve.summary.endEquity).toBeCloseTo(endPoint.cashBalance + 19.95, 6);
  });

  it('returns recent trade-log rows with component quality bands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-trade-log-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'BTC',
      side: 'buy',
      signalClass: 'breakout_15m',
      outcome: 'executed',
      directionScore: 0.9,
      timingScore: 0.8,
      sizingScore: 0.75,
      exitScore: 0.7,
      capturedR: 1.2,
      thesisCorrect: true,
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'ETH',
      side: 'sell',
      signalClass: 'mean_reversion_5m',
      outcome: 'failed',
      directionScore: 0.2,
      timingScore: 0.25,
      sizingScore: 0.3,
      exitScore: 0.2,
      capturedR: -0.9,
      thesisCorrect: false,
    });

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.tradeLog.rows.length).toBe(2);
    const bySymbol = new Map(payload.sections.tradeLog.rows.map((row) => [row.symbol, row]));
    expect(bySymbol.get('BTC')?.qualityBand).toBe('good');
    expect(bySymbol.get('ETH')?.qualityBand).toBe('poor');
    expect(bySymbol.get('BTC')?.rCaptured).toBe(1.2);
    expect(bySymbol.get('ETH')?.rCaptured).toBe(-0.9);
  });

  it('builds non-empty signal/regime/session performance breakdown from journals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-performance-breakdown-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    // Real pattern: entry journal carries signalClass/regime, close journal carries outcome.
    // Entry and close are linked temporally (close recorded shortly after entry).
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      execution_mode: 'paper',
      symbol: 'BTC',
      side: 'sell',
      signalClass: 'momentum_breakout',
      marketRegime: 'trending',
      outcome: 'executed',
      reduceOnly: false,
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      execution_mode: 'paper',
      symbol: 'BTC',
      side: 'buy',
      reduceOnly: true,
      outcome: 'executed',
      capturedR: 1.25,
      captured_r: 1.25,
      thesisCorrect: true,
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      execution_mode: 'paper',
      symbol: 'ETH',
      side: 'buy',
      signalClass: 'mean_reversion',
      marketRegime: 'choppy',
      outcome: 'executed',
      reduceOnly: false,
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      execution_mode: 'paper',
      symbol: 'ETH',
      side: 'sell',
      reduceOnly: true,
      outcome: 'executed',
      capturedR: -0.75,
      captured_r: -0.75,
      thesisCorrect: false,
    });

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.performanceBreakdown.bySignalClass.length).toBeGreaterThan(0);
    expect(payload.sections.performanceBreakdown.byRegime.length).toBeGreaterThan(0);
    expect(payload.sections.performanceBreakdown.bySession.length).toBeGreaterThan(0);

    const scMap = new Map(payload.sections.performanceBreakdown.bySignalClass.map((r) => [r.key, r]));
    expect(scMap.get('momentum_breakout')?.winRate).toBe(1);
    expect(scMap.get('momentum_breakout')?.expectancyR).toBeCloseTo(1.25);
    expect(scMap.get('mean_reversion')?.winRate).toBe(0);
    expect(scMap.get('mean_reversion')?.expectancyR).toBeCloseTo(-0.75);
  });

  it('returns promotion gate rows keyed by symbol:signalClass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-promo-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'BTC',
      signalClass: 'breakout_15m',
      outcome: 'executed',
      capturedR: 1.2,
      thesisCorrect: true,
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'BTC',
      signalClass: 'breakout_15m',
      outcome: 'failed',
      capturedR: -0.5,
      thesisCorrect: false,
    });

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    const rows = payload.sections.promotionGates.rows as Array<any>;
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find((item) => item.setupKey === 'BTC:breakout_15m');
    expect(row).toBeDefined();
    expect(row?.sampleCount).toBe(2);
    expect(row?.gates.minTrades.pass).toBe(false);
    expect(row?.gates.minTrades.missing).toBe(23);
  });

  it('counts one trade per unique tradeId even when multiple journals exist for the lifecycle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-unique-trade-count-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      tradeId: 42,
      execution_mode: 'paper',
      symbol: 'BTC',
      side: 'buy',
      outcome: 'executed',
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      tradeId: 42,
      execution_mode: 'paper',
      symbol: 'BTC',
      side: 'buy',
      outcome: 'executed',
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      tradeId: 42,
      execution_mode: 'paper',
      symbol: 'BTC',
      side: 'sell',
      outcome: 'executed',
    });

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.meta.recordCounts.journals).toBe(3);
    expect(payload.meta.recordCounts.perpTrades).toBe(1);
  });

  it('separates paper and live slices across sections when mode filter changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-mode-split-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    placePaperPerpOrder(
      { symbol: 'BTC', side: 'buy', size: 1, orderType: 'market', markPrice: 100 },
      { initialCashUsdc: 200 }
    );

    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'BTC',
      side: 'buy',
      signalClass: 'breakout_15m',
      outcome: 'executed',
      directionScore: 0.8,
      timingScore: 0.8,
      sizingScore: 0.8,
      exitScore: 0.8,
      capturedR: 1,
      thesisCorrect: true,
    });

    storeDecisionArtifact({
      source: 'perps',
      kind: 'perp_trade_journal',
      marketId: 'ETH',
      outcome: 'executed',
      payload: {
        kind: 'perp_trade_journal',
        symbol: 'ETH',
        side: 'sell',
        signalClass: 'momentum_5m',
        outcome: 'executed',
        directionScore: 0.7,
        timingScore: 0.75,
        sizingScore: 0.8,
        exitScore: 0.85,
        capturedR: 1.1,
        thesisCorrect: true,
        mode: 'live',
      },
    });

    const paperPayload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    const livePayload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'live',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(paperPayload.meta.recordCounts.journals).toBe(1);
    expect(livePayload.meta.recordCounts.journals).toBe(1);

    expect(paperPayload.sections.equityCurve.points.length).toBeGreaterThan(0);
    expect(livePayload.sections.equityCurve.points).toEqual([]);
    expect(livePayload.sections.equityCurve.summary.startEquity).toBeNull();
    expect(livePayload.sections.openPositions.rows).toEqual([]);
    expect(livePayload.meta.recordCounts.openPaperPositions).toBe(0);

    expect(paperPayload.sections.openPositions.rows.length).toBe(1);
    expect(paperPayload.sections.tradeLog.rows.some((row) => row.symbol === 'BTC')).toBe(true);
    expect(paperPayload.sections.tradeLog.rows.some((row) => row.symbol === 'ETH')).toBe(false);
    expect(livePayload.sections.tradeLog.rows.some((row) => row.symbol === 'ETH')).toBe(true);
    expect(livePayload.sections.tradeLog.rows.some((row) => row.symbol === 'BTC')).toBe(false);

    expect(
      paperPayload.sections.promotionGates.rows.some((row) => row.setupKey === 'BTC:breakout_15m')
    ).toBe(true);
    expect(
      paperPayload.sections.promotionGates.rows.some((row) => row.setupKey === 'ETH:momentum_5m')
    ).toBe(false);
    expect(
      livePayload.sections.promotionGates.rows.some((row) => row.setupKey === 'ETH:momentum_5m')
    ).toBe(true);
    expect(
      livePayload.sections.promotionGates.rows.some((row) => row.setupKey === 'BTC:breakout_15m')
    ).toBe(false);
  });

  it('filters perp_trades fallback trade log by execution_mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-perp-trades-mode-filter-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    db.prepare(
      `
        INSERT INTO perp_trades (symbol, side, size, execution_mode, status)
        VALUES (?, ?, ?, ?, ?)
      `
    ).run('BTC', 'buy', 0.01, 'paper', 'executed');
    db.prepare(
      `
        INSERT INTO perp_trades (symbol, side, size, execution_mode, status)
        VALUES (?, ?, ?, ?, ?)
      `
    ).run('ETH', 'sell', 0.02, 'live', 'executed');

    const paperPayload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });
    const livePayload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'live',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(paperPayload.sections.tradeLog.rows.some((row) => row.symbol === 'BTC')).toBe(true);
    expect(paperPayload.sections.tradeLog.rows.some((row) => row.symbol === 'ETH')).toBe(false);
    expect(livePayload.sections.tradeLog.rows.some((row) => row.symbol === 'ETH')).toBe(true);
    expect(livePayload.sections.tradeLog.rows.some((row) => row.symbol === 'BTC')).toBe(false);
  });

  it('returns policy state from autonomy policy table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-policy-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    process.env.THUFIR_DASHBOARD_MAX_TRADES_PER_DAY = '5';
    const db = openDatabase(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_policy_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_date TEXT NOT NULL,
        observation_only_until_ms INTEGER,
        leverage_cap_override REAL,
        updated_at TEXT NOT NULL
      );
    `);

    db.exec(`
      INSERT INTO autonomy_policy_state (
        session_date, observation_only_until_ms, leverage_cap_override, updated_at
      )
      VALUES (
        '2026-02-25',
        ${Date.now() + 60_000},
        1.25,
        '2026-02-25T18:30:00.000Z'
      );
    `);

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'combined',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.policyState.observationMode).toBe(true);
    expect(payload.sections.policyState.leverageCap).toBe(1.25);
    expect(payload.sections.policyState.tradesRemainingToday).toBe(5);
    expect(payload.sections.policyState.updatedAt).toBe('2026-02-25T18:30:00.000Z');
    delete process.env.THUFIR_DASHBOARD_MAX_TRADES_PER_DAY;
  });

  it('returns policy state from payload-based autonomy policy schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-policy-payload-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    process.env.THUFIR_DASHBOARD_MAX_TRADES_PER_DAY = '4';
    const db = openDatabase(dbPath);

    db.exec(`
      DROP TABLE IF EXISTS autonomy_policy_state;
      CREATE TABLE autonomy_policy_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        updated_at TEXT
      );
    `);

    db.prepare(
      `
        INSERT INTO autonomy_policy_state (payload, updated_at)
        VALUES (?, ?)
      `
    ).run(
      JSON.stringify({
        observationOnlyUntilMs: Date.now() + 120_000,
        leverageCapOverride: 1.5,
      }),
      '2026-02-25T19:00:00.000Z'
    );

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'combined',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.policyState.observationMode).toBe(true);
    expect(payload.sections.policyState.leverageCap).toBe(1.5);
    expect(payload.sections.policyState.tradesRemainingToday).toBe(4);
    expect(payload.sections.policyState.updatedAt).toBe('2026-02-25T19:00:00.000Z');
    delete process.env.THUFIR_DASHBOARD_MAX_TRADES_PER_DAY;
  });

  it('derives drawdown cap remaining from configured daily cap and todays pnl rollup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-policy-drawdown-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    process.env.THUFIR_DASHBOARD_DAILY_DRAWDOWN_CAP_USD = '100';
    const db = openDatabase(dbPath);

    db.exec(`
      DROP TABLE IF EXISTS autonomy_policy_state;
      CREATE TABLE autonomy_policy_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        updated_at TEXT
      );
    `);

    db.prepare(
      `
        INSERT INTO autonomy_policy_state (payload, updated_at)
        VALUES (?, ?)
      `
    ).run(
      JSON.stringify({
        observationOnlyUntilMs: Date.now() + 120_000,
        leverageCapOverride: 1.5,
      }),
      '2026-02-25T19:00:00.000Z'
    );

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'combined',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.policyState.drawdownCapRemainingUsd).toBe(100);
    delete process.env.THUFIR_DASHBOARD_DAILY_DRAWDOWN_CAP_USD;
  });
});

describe('dashboard api route handler', () => {
  let dbPath: string | null = null;
  let dbDir: string | null = null;
  const originalDbPath = process.env.THUFIR_DB_PATH;

  afterEach(() => {
    process.env.THUFIR_DB_PATH = originalDbPath;
    if (dbPath) {
      rmSync(dbPath, { force: true });
      dbPath = null;
    }
    if (dbDir) {
      rmSync(dbDir, { recursive: true, force: true });
      dbDir = null;
    }
  });

  it('handles dashboard requests and returns json', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-api-handler-'));
    dbPath = join(dbDir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    openDatabase(dbPath);

    const req = {
      method: 'GET',
      url: '/api/dashboard?mode=paper&timeframe=all',
      headers: { host: 'localhost:18789' },
    } as any;

    const state: { status?: number; body?: string } = {};
    const res = {
      writeHead: (status: number) => {
        state.status = status;
      },
      end: (body?: string) => {
        state.body = body;
      },
    } as any;

    const handled = handleDashboardApiRequest(req, res);
    expect(handled).toBe(true);
    expect(state.status).toBe(200);
    const parsed = JSON.parse(String(state.body)) as {
      meta: { mode: string };
    };
    expect(parsed.meta.mode).toBe('paper');
  });

  it('ignores non-dashboard paths', () => {
    const req = {
      method: 'GET',
      url: '/health',
      headers: { host: 'localhost:18789' },
    } as any;
    const res = {
      writeHead: () => undefined,
      end: () => undefined,
    } as any;
    expect(handleDashboardApiRequest(req, res)).toBe(false);
  });
});
