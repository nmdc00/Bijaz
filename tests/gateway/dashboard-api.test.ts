import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/memory/db.js';
import { placePaperPerpOrder } from '../../src/memory/paper_perps.js';
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
