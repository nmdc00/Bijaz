import type { IncomingMessage, ServerResponse } from 'node:http';

import type Database from 'better-sqlite3';

import { openDatabase } from '../memory/db.js';

export type DashboardMode = 'paper' | 'live' | 'combined';
export type DashboardTimeframe = 'day' | 'period' | 'all' | 'custom';

export type DashboardFilters = {
  mode: DashboardMode;
  timeframe: DashboardTimeframe;
  period: string | null;
  from: string | null;
  to: string | null;
};

function normalizeIso(input: string | null): string | null {
  if (!input) return null;
  const value = input.trim();
  if (!value) return null;
  const dt = new Date(value);
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
}

function utcStartOfDayIso(now: Date): string {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export function parseDashboardFilters(url: URL, now = new Date()): DashboardFilters {
  const rawMode = String(url.searchParams.get('mode') ?? '').trim().toLowerCase();
  const mode: DashboardMode =
    rawMode === 'paper' || rawMode === 'live' || rawMode === 'combined' ? rawMode : 'combined';

  const rawTimeframe = String(url.searchParams.get('timeframe') ?? '').trim().toLowerCase();
  const timeframe: DashboardTimeframe =
    rawTimeframe === 'day' || rawTimeframe === 'period' || rawTimeframe === 'all' || rawTimeframe === 'custom'
      ? rawTimeframe
      : 'all';

  const period = String(url.searchParams.get('period') ?? '').trim() || null;
  const requestedFrom = normalizeIso(url.searchParams.get('from'));
  const requestedTo = normalizeIso(url.searchParams.get('to'));

  if (timeframe === 'day') {
    return {
      mode,
      timeframe,
      period: null,
      from: utcStartOfDayIso(now),
      to: now.toISOString(),
    };
  }

  if (timeframe === 'period') {
    return {
      mode,
      timeframe,
      period: period ?? '30d',
      from: requestedFrom,
      to: requestedTo,
    };
  }

  if (timeframe === 'custom') {
    return {
      mode,
      timeframe,
      period: null,
      from: requestedFrom,
      to: requestedTo,
    };
  }

  return {
    mode,
    timeframe: 'all',
    period: null,
    from: null,
    to: null,
  };
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function safeCount(
  db: Database.Database,
  query: string,
  params: ReadonlyArray<unknown> = []
): number {
  try {
    const row = db.prepare(query).get(...params) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

export function buildDashboardApiPayload(params?: {
  db?: Database.Database;
  filters?: DashboardFilters;
}): {
  meta: {
    generatedAt: string;
    mode: DashboardMode;
    timeframe: DashboardTimeframe;
    period: string | null;
    from: string | null;
    to: string | null;
    recordCounts: {
      perpTrades: number;
      journals: number;
      openPaperPositions: number;
      alerts: number;
    };
  };
  sections: {
    equityCurve: {
      points: unknown[];
      summary: {
        startEquity: number | null;
        endEquity: number | null;
        returnPct: number | null;
        maxDrawdownPct: number | null;
      };
    };
    openPositions: {
      rows: unknown[];
      summary: {
        totalUnrealizedPnlUsd: number;
        longCount: number;
        shortCount: number;
      };
    };
    tradeLog: {
      rows: unknown[];
      limit: number;
    };
    promotionGates: {
      rows: unknown[];
    };
    policyState: {
      observationMode: boolean;
      leverageCap: number | null;
      drawdownCapRemainingUsd: number | null;
      tradesRemainingToday: number | null;
      updatedAt: string | null;
    };
    performanceBreakdown: {
      bySignalClass: unknown[];
      byRegime: unknown[];
      bySession: unknown[];
    };
  };
} {
  const db = params?.db ?? openDatabase();
  const filters = params?.filters ?? {
    mode: 'combined',
    timeframe: 'all',
    period: null,
    from: null,
    to: null,
  };

  const perpTrades = safeCount(db, 'SELECT COUNT(*) AS c FROM perp_trades');
  const journals = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM decision_artifacts WHERE kind = 'perp_trade_journal'"
  );
  const alerts = safeCount(db, 'SELECT COUNT(*) AS c FROM alerts');
  const openPaperPositions = tableExists(db, 'paper_perp_positions')
    ? safeCount(db, 'SELECT COUNT(*) AS c FROM paper_perp_positions')
    : 0;

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      mode: filters.mode,
      timeframe: filters.timeframe,
      period: filters.period,
      from: filters.from,
      to: filters.to,
      recordCounts: {
        perpTrades,
        journals,
        openPaperPositions,
        alerts,
      },
    },
    sections: {
      equityCurve: {
        points: [],
        summary: {
          startEquity: null,
          endEquity: null,
          returnPct: null,
          maxDrawdownPct: null,
        },
      },
      openPositions: {
        rows: [],
        summary: {
          totalUnrealizedPnlUsd: 0,
          longCount: 0,
          shortCount: 0,
        },
      },
      tradeLog: {
        rows: [],
        limit: 30,
      },
      promotionGates: {
        rows: [],
      },
      policyState: {
        observationMode: false,
        leverageCap: null,
        drawdownCapRemainingUsd: null,
        tradesRemainingToday: null,
        updatedAt: null,
      },
      performanceBreakdown: {
        bySignalClass: [],
        byRegime: [],
        bySession: [],
      },
    },
  };
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function handleDashboardApiRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  if (!path.startsWith('/api/dashboard')) {
    return false;
  }

  if (req.method !== 'GET') {
    writeJson(res, 405, { ok: false, error: 'Method not allowed' });
    return true;
  }

  if (path === '/api/dashboard/health') {
    writeJson(res, 200, { ok: true, service: 'dashboard-api' });
    return true;
  }

  if (path === '/api/dashboard' || path === '/api/dashboard/summary') {
    const filters = parseDashboardFilters(url);
    const payload = buildDashboardApiPayload({ filters });
    writeJson(res, 200, payload);
    return true;
  }

  writeJson(res, 404, { ok: false, error: 'Not found' });
  return true;
}
