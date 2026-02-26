import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/memory/db.js';
import { storeDecisionArtifact } from '../../src/memory/decision_artifacts.js';
import { placePaperPerpOrder } from '../../src/memory/paper_perps.js';
import { recordPerpTradeJournal } from '../../src/memory/perp_trade_journal.js';
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
    expect(typeof payload.meta.recordCounts.perpTrades).toBe('number');
    expect(typeof payload.meta.recordCounts.journals).toBe('number');
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

    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'BTC',
      side: 'buy',
      signalClass: 'momentum_breakout',
      marketRegime: 'trending',
      outcome: 'executed',
      capturedR: 1.25,
      thesisCorrect: true,
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'ETH',
      side: 'sell',
      signalClass: 'mean_reversion',
      marketRegime: 'choppy',
      outcome: 'failed',
      capturedR: -0.75,
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
