import type { IncomingMessage, ServerResponse } from 'node:http';

import type Database from 'better-sqlite3';

import { buildPaperPromotionReport } from '../core/paper_promotion.js';
import { loadConfig, type ThufirConfig } from '../core/config.js';
import { getDailyPnLRollup } from '../core/daily_pnl.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import { openDatabase } from '../memory/db.js';
import type { PerpTradeJournalEntry } from '../memory/perp_trade_journal.js';

export type DashboardMode = 'paper' | 'live' | 'combined';
export type DashboardTimeframe = 'day' | 'period' | 'all' | 'custom';

export type DashboardFilters = {
  mode: DashboardMode;
  timeframe: DashboardTimeframe;
  period: string | null;
  from: string | null;
  to: string | null;
};

type TimeRange = {
  fromMs: number | null;
  toMs: number | null;
};

type PaperPerpFillRow = {
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  fillPrice: number;
  markPrice: number;
  realizedPnlUsd: number;
  feeUsd: number;
  createdAt: string;
};

type PositionState = {
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
};

type EquityPoint = {
  timestamp: string;
  cashBalance: number;
  unrealizedPnl: number;
  equity: number;
  cumulativeRealizedPnl: number;
  cumulativeFees: number;
};

type EquityCurveSection = {
  points: EquityPoint[];
  summary: {
    startEquity: number | null;
    endEquity: number | null;
    returnPct: number | null;
    maxDrawdownPct: number | null;
  };
};

function getDashboardConfig(): ThufirConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

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

function resolvePeriodWindow(periodRaw: string | null, nowMs: number): TimeRange {
  const period = (periodRaw ?? '30d').trim().toLowerCase();
  const match = period.match(/^(\d+)([dhwm])$/);
  if (!match) {
    return { fromMs: null, toMs: null };
  }
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) {
    return { fromMs: null, toMs: null };
  }
  const multiplier =
    unit === 'd'
      ? 24 * 60 * 60 * 1000
      : unit === 'h'
        ? 60 * 60 * 1000
        : unit === 'w'
          ? 7 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000;
  return { fromMs: nowMs - value * multiplier, toMs: nowMs };
}

function resolveTimeRange(filters: DashboardFilters, now = new Date()): TimeRange {
  const nowMs = now.getTime();
  if (filters.timeframe === 'all') {
    return { fromMs: null, toMs: null };
  }

  if (filters.timeframe === 'day') {
    const fromMs = Date.parse(filters.from ?? '');
    const toMs = Date.parse(filters.to ?? '');
    return {
      fromMs: Number.isFinite(fromMs) ? fromMs : null,
      toMs: Number.isFinite(toMs) ? toMs : nowMs,
    };
  }

  if (filters.timeframe === 'period') {
    return resolvePeriodWindow(filters.period, nowMs);
  }

  const fromMs = Date.parse(filters.from ?? '');
  const toMs = Date.parse(filters.to ?? '');
  return {
    fromMs: Number.isFinite(fromMs) ? fromMs : null,
    toMs: Number.isFinite(toMs) ? toMs : null,
  };
}

function isLiveMode(filters: DashboardFilters): boolean {
  return filters.mode === 'live';
}

function isPaperMode(filters: DashboardFilters): boolean {
  return filters.mode === 'paper';
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function tableHasColumn(
  db: Database.Database,
  tableName: string,
  columnName: string
): boolean {
  if (!tableExists(db, tableName)) return false;
  try {
    const rows = db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === columnName);
  } catch {
    return false;
  }
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

function listPaperPerpFills(db: Database.Database): PaperPerpFillRow[] {
  if (!tableExists(db, 'paper_perp_fills')) {
    return [];
  }
  const rows = db
    .prepare(
      `
        SELECT symbol,
               side,
               size,
               fill_price as fillPrice,
               mark_price as markPrice,
               realized_pnl_usd as realizedPnlUsd,
               fee_usd as feeUsd,
               created_at as createdAt
        FROM paper_perp_fills
        ORDER BY created_at ASC, id ASC
      `
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    symbol: String(row.symbol ?? '').toUpperCase(),
    side: String(row.side ?? 'buy') === 'sell' ? 'sell' : 'buy',
    size: Number(row.size ?? 0),
    fillPrice: Number(row.fillPrice ?? 0),
    markPrice: Number(row.markPrice ?? row.fillPrice ?? 0),
    realizedPnlUsd: Number(row.realizedPnlUsd ?? 0),
    feeUsd: Number(row.feeUsd ?? 0),
    createdAt: String(row.createdAt ?? ''),
  }));
}

function applyFillToPositionState(
  map: Map<string, PositionState>,
  fill: PaperPerpFillRow
): void {
  const size = Number(fill.size);
  const price = Number(fill.fillPrice);
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
    return;
  }

  const symbol = fill.symbol;
  const existing = map.get(symbol);
  const existingSigned =
    existing == null ? 0 : existing.side === 'long' ? existing.size : -existing.size;
  const fillSigned = fill.side === 'buy' ? size : -size;
  const nextSigned = existingSigned + fillSigned;

  if (existingSigned === 0) {
    map.set(symbol, {
      side: fillSigned >= 0 ? 'long' : 'short',
      size: Math.abs(fillSigned),
      entryPrice: price,
    });
    return;
  }

  if (Math.sign(existingSigned) === Math.sign(fillSigned)) {
    if (!existing) {
      return;
    }
    const nextSize = Math.abs(nextSigned);
    const weightedEntry =
      (Math.abs(existingSigned) * existing.entryPrice + Math.abs(fillSigned) * price) / nextSize;
    map.set(symbol, {
      side: nextSigned >= 0 ? 'long' : 'short',
      size: nextSize,
      entryPrice: weightedEntry,
    });
    return;
  }

  if (Math.abs(fillSigned) < Math.abs(existingSigned)) {
    if (!existing) {
      return;
    }
    map.set(symbol, {
      side: existing.side,
      size: Math.abs(nextSigned),
      entryPrice: existing.entryPrice,
    });
    return;
  }

  if (Math.abs(fillSigned) === Math.abs(existingSigned)) {
    map.delete(symbol);
    return;
  }

  map.set(symbol, {
    side: nextSigned >= 0 ? 'long' : 'short',
    size: Math.abs(nextSigned),
    entryPrice: price,
  });
}

function computeUnrealizedPnl(
  positions: Map<string, PositionState>,
  lastMarkBySymbol: Map<string, number>
): number {
  let total = 0;
  for (const [symbol, position] of positions.entries()) {
    const mark = lastMarkBySymbol.get(symbol) ?? position.entryPrice;
    const delta =
      position.side === 'long'
        ? (mark - position.entryPrice) * position.size
        : (position.entryPrice - mark) * position.size;
    total += Number.isFinite(delta) ? delta : 0;
  }
  return total;
}

function buildPaperEquitySeries(
  db: Database.Database,
  filters: DashboardFilters
): EquityCurveSection {
  const startingCash = safeCount(
    db,
    'SELECT COALESCE(starting_cash_usdc, 200) AS c FROM paper_perp_book WHERE id = 1'
  );
  const fills = listPaperPerpFills(db);
  const { fromMs, toMs } = resolveTimeRange(filters);
  const positions = new Map<string, PositionState>();
  const lastMarkBySymbol = new Map<string, number>();
  const points: EquityPoint[] = [];
  let cashBalance = startingCash > 0 ? startingCash : 200;
  let cumulativeRealized = 0;
  let cumulativeFees = 0;

  for (const fill of fills) {
    const fillMs = Date.parse(fill.createdAt);
    if (!Number.isFinite(fillMs)) {
      continue;
    }
    applyFillToPositionState(positions, fill);
    lastMarkBySymbol.set(fill.symbol, fill.markPrice);

    cumulativeRealized += fill.realizedPnlUsd;
    cumulativeFees += fill.feeUsd;
    cashBalance += fill.realizedPnlUsd - fill.feeUsd;
    const unrealizedPnl = computeUnrealizedPnl(positions, lastMarkBySymbol);
    const equity = cashBalance + unrealizedPnl;

    const inRange =
      (fromMs == null || fillMs >= fromMs) &&
      (toMs == null || fillMs <= toMs);
    if (inRange) {
      points.push({
        timestamp: new Date(fillMs).toISOString(),
        cashBalance,
        unrealizedPnl,
        equity,
        cumulativeRealizedPnl: cumulativeRealized,
        cumulativeFees,
      });
    }
  }

  if (points.length === 0) {
    points.push({
      timestamp: new Date().toISOString(),
      cashBalance,
      unrealizedPnl: 0,
      equity: cashBalance,
      cumulativeRealizedPnl: cumulativeRealized,
      cumulativeFees,
    });
  }

  const startEquity = points[0]?.equity ?? null;
  const endEquity = points[points.length - 1]?.equity ?? null;
  const returnPct =
    startEquity != null && endEquity != null && Math.abs(startEquity) > 1e-9
      ? ((endEquity - startEquity) / startEquity) * 100
      : null;
  let peak = Number.NEGATIVE_INFINITY;
  let maxDrawdownPct = 0;
  for (const point of points) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      const dd = ((peak - point.equity) / peak) * 100;
      maxDrawdownPct = Math.max(maxDrawdownPct, dd);
    }
  }

  return {
    points,
    summary: {
      startEquity,
      endEquity,
      returnPct,
      maxDrawdownPct,
    },
  };
}

function buildEmptyEquitySeries(): EquityCurveSection {
  return {
    points: [],
    summary: {
      startEquity: null,
      endEquity: null,
      returnPct: null,
      maxDrawdownPct: null,
    },
  };
}

type LiveWalletSnapshot = {
  equityCurve: EquityCurveSection;
  openPositions: {
    rows: OpenPositionRow[];
    summary: {
      totalUnrealizedPnlUsd: number;
      longCount: number;
      shortCount: number;
    };
  };
};

async function tryBuildLiveWalletSnapshot(config: ThufirConfig): Promise<LiveWalletSnapshot | null> {
  try {
    const client = new HyperliquidClient(config);
    const state = (await client.getClearinghouseState()) as {
      assetPositions?: Array<{ position?: Record<string, unknown> }>;
      marginSummary?: Record<string, unknown>;
      crossMarginSummary?: Record<string, unknown>;
      withdrawable?: string | number;
    };
    const spotState = (await client.getSpotClearinghouseState()) as {
      balances?: Array<Record<string, unknown>>;
    };
    const dexAbstraction = await client.getUserDexAbstraction().catch(() => null);

    const toNumber = (value: unknown): number | null => {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };

    const nowIso = new Date().toISOString();
    const rows: OpenPositionRow[] = [];
    let totalUnrealizedPnlUsd = 0;
    let longCount = 0;
    let shortCount = 0;

    for (const entry of state.assetPositions ?? []) {
      const position = entry?.position ?? {};
      const signedSize = toNumber((position as { szi?: unknown }).szi);
      if (signedSize == null || signedSize === 0) continue;
      const size = Math.abs(signedSize);
      const side: 'long' | 'short' = signedSize > 0 ? 'long' : 'short';
      const entryPrice = toNumber((position as { entryPx?: unknown }).entryPx) ?? 0;
      const unrealizedPnlUsd = toNumber((position as { unrealizedPnl?: unknown }).unrealizedPnl) ?? 0;
      const impliedCurrent =
        size > 0
          ? side === 'long'
            ? entryPrice + unrealizedPnlUsd / size
            : entryPrice - unrealizedPnlUsd / size
          : entryPrice;
      rows.push({
        symbol: String((position as { coin?: unknown }).coin ?? '').toUpperCase(),
        side,
        entryPrice,
        currentPrice: Number.isFinite(impliedCurrent) ? impliedCurrent : entryPrice,
        size,
        unrealizedPnlUsd,
        heldSeconds: 0,
        openedAt: '',
        updatedAt: nowIso,
      });
      totalUnrealizedPnlUsd += unrealizedPnlUsd;
      if (side === 'long') longCount += 1;
      if (side === 'short') shortCount += 1;
    }

    const spotUsdcRow = (spotState.balances ?? []).find(
      (row) => String(row.coin ?? '').trim().toUpperCase() === 'USDC'
    );
    const spotUsdcTotal = toNumber(spotUsdcRow?.total ?? null) ?? 0;
    const spotUsdcHold = toNumber(spotUsdcRow?.hold ?? null) ?? 0;
    const spotUsdcFree = Math.max(0, spotUsdcTotal - spotUsdcHold);
    const perpWithdrawable = toNumber(state.withdrawable ?? null) ?? 0;
    const availableBalance =
      dexAbstraction === true
        ? spotUsdcFree
        : perpWithdrawable > 0
          ? perpWithdrawable
          : spotUsdcFree;
    const accountValue = availableBalance;
    const equityCurve =
      accountValue != null
        ? {
            points: [
              {
                timestamp: nowIso,
                cashBalance: accountValue - totalUnrealizedPnlUsd,
                unrealizedPnl: totalUnrealizedPnlUsd,
                equity: accountValue,
                cumulativeRealizedPnl: 0,
                cumulativeFees: 0,
              },
            ],
            summary: {
              startEquity: accountValue,
              endEquity: accountValue,
              returnPct: 0,
              maxDrawdownPct: 0,
            },
          }
        : buildEmptyEquitySeries();

    return {
      equityCurve,
      openPositions: {
        rows,
        summary: {
          totalUnrealizedPnlUsd,
          longCount,
          shortCount,
        },
      },
    };
  } catch {
    return null;
  }
}
type OpenPositionRow = {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  size: number;
  unrealizedPnlUsd: number;
  heldSeconds: number;
  openedAt: string;
  updatedAt: string;
};

function listPaperOpenPositionRows(db: Database.Database): OpenPositionRow[] {
  if (!tableExists(db, 'paper_perp_positions')) {
    return [];
  }

  const rows = db
    .prepare(
      `
        SELECT p.symbol,
               p.side,
               p.size,
               p.entry_price as entryPrice,
               p.opened_at as openedAt,
               p.updated_at as updatedAt,
               COALESCE(m.mark_price, p.entry_price) as currentPrice
        FROM paper_perp_positions p
        LEFT JOIN (
          SELECT f.symbol, f.mark_price
          FROM paper_perp_fills f
          INNER JOIN (
            SELECT symbol, MAX(id) as max_id
            FROM paper_perp_fills
            GROUP BY symbol
          ) latest
            ON latest.symbol = f.symbol
           AND latest.max_id = f.id
        ) m
          ON m.symbol = p.symbol
        ORDER BY p.symbol ASC
      `
    )
    .all() as Array<Record<string, unknown>>;

  const nowMs = Date.now();
  return rows.map((row) => {
    const symbol = String(row.symbol ?? '').toUpperCase();
    const side = String(row.side ?? 'long') === 'short' ? 'short' : 'long';
    const size = Number(row.size ?? 0);
    const entryPrice = Number(row.entryPrice ?? 0);
    const currentPrice = Number(row.currentPrice ?? entryPrice);
    const openedAt = String(row.openedAt ?? '');
    const updatedAt = String(row.updatedAt ?? '');
    const openedMs = Date.parse(openedAt);
    const heldSeconds =
      Number.isFinite(openedMs) && nowMs > openedMs
        ? Math.floor((nowMs - openedMs) / 1000)
        : 0;
    const unrealizedPnlUsd =
      side === 'long'
        ? (currentPrice - entryPrice) * size
        : (entryPrice - currentPrice) * size;
    return {
      symbol,
      side,
      entryPrice,
      currentPrice,
      size,
      unrealizedPnlUsd: Number.isFinite(unrealizedPnlUsd) ? unrealizedPnlUsd : 0,
      heldSeconds,
      openedAt,
      updatedAt,
    };
  });
}

type TradeLogRow = {
  tradeId: number | null;
  symbol: string;
  side: 'buy' | 'sell' | null;
  signalClass: string | null;
  outcome: 'executed' | 'failed' | 'blocked' | 'unknown';
  directionScore: number | null;
  timingScore: number | null;
  sizingScore: number | null;
  exitScore: number | null;
  rCaptured: number | null;
  thesisCorrect: boolean | null;
  qualityBand: 'good' | 'mixed' | 'poor' | 'unknown';
  closedAt: string;
};

function toOptionalScore(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function resolveQualityBand(row: {
  directionScore: number | null;
  timingScore: number | null;
  sizingScore: number | null;
  exitScore: number | null;
}): 'good' | 'mixed' | 'poor' | 'unknown' {
  const scores = [row.directionScore, row.timingScore, row.sizingScore, row.exitScore].filter(
    (value): value is number => value != null
  );
  if (scores.length === 0) return 'unknown';
  const avg = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  if (avg >= 0.7) return 'good';
  if (avg < 0.45) return 'poor';
  return 'mixed';
}

function resolveJournalEntryMode(payload: Record<string, unknown>): DashboardMode | null {
  const candidates = [
    payload.mode,
    payload.bookMode,
    payload.perpMode,
    payload.executionMode,
    payload.execution_mode,
    payload.perp_mode,
    payload.book_mode,
  ];
  for (const candidate of candidates) {
    const value = String(candidate ?? '')
      .trim()
      .toLowerCase();
    if (value === 'paper' || value === 'live' || value === 'combined') {
      return value as DashboardMode;
    }
  }
  return null;
}

function journalModeMatches(payload: Record<string, unknown>, filters: DashboardFilters): boolean {
  if (filters.mode === 'combined') {
    return true;
  }
  const entryMode = resolveJournalEntryMode(payload);
  if (entryMode == null) {
    // Legacy journal entries are treated as paper unless explicitly tagged.
    return filters.mode === 'paper';
  }
  return entryMode === filters.mode;
}

function resolveJournalSignalClass(payload: Record<string, unknown>): string | null {
  const candidates = [payload.signalClass, payload.signal_class];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function resolveJournalMarketRegime(payload: Record<string, unknown>): string | null {
  const candidates = [payload.marketRegime, payload.market_regime];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function listTradeLogRows(
  db: Database.Database,
  filters: DashboardFilters,
  limit = 30
): TradeLogRow[] {
  const rows = db
    .prepare(
      `
        SELECT payload, created_at as createdAt
        FROM decision_artifacts
        WHERE kind = 'perp_trade_journal'
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(Math.max(1, Math.min(limit, 100))) as Array<{ payload?: string; createdAt?: string }>;

  const out: TradeLogRow[] = [];
  for (const row of rows) {
    if (!row.payload) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!journalModeMatches(payload, filters)) {
      continue;
    }

    const outcomeRaw = String(payload.outcome ?? '').trim().toLowerCase();
    if (outcomeRaw !== 'executed' && outcomeRaw !== 'failed' && outcomeRaw !== 'blocked') {
      continue;
    }
    if (outcomeRaw === 'blocked') {
      continue;
    }

    const directionScore = toOptionalScore(payload.directionScore ?? payload.direction_score);
    const timingScore = toOptionalScore(payload.timingScore ?? payload.timing_score);
    const sizingScore = toOptionalScore(payload.sizingScore ?? payload.sizing_score);
    const exitScore = toOptionalScore(payload.exitScore ?? payload.exit_score);
    const rCapturedRaw = Number(payload.capturedR ?? payload.captured_r);
    const rCaptured = Number.isFinite(rCapturedRaw) ? rCapturedRaw : null;
    const sideRaw = String(payload.side ?? '').trim().toLowerCase();
    const side: 'buy' | 'sell' | null = sideRaw === 'buy' || sideRaw === 'sell' ? sideRaw : null;
    const thesisCorrect =
      typeof payload.thesisCorrect === 'boolean' ? payload.thesisCorrect : null;
    const closedAt = String(payload.closedAt ?? row.createdAt ?? new Date().toISOString());

    const tradeIdRaw = Number(payload.tradeId);
    out.push({
      tradeId: Number.isFinite(tradeIdRaw) ? tradeIdRaw : null,
      symbol: String(payload.symbol ?? '').toUpperCase(),
      side,
      signalClass: resolveJournalSignalClass(payload),
      outcome: outcomeRaw as 'executed' | 'failed',
      directionScore,
      timingScore,
      sizingScore,
      exitScore,
      rCaptured,
      thesisCorrect,
      qualityBand: resolveQualityBand({
        directionScore,
        timingScore,
        sizingScore,
        exitScore,
      }),
      closedAt,
    });
  }

  return out;
}

function listTradeLogRowsFromPerpTrades(
  db: Database.Database,
  filters: DashboardFilters,
  limit = 30
): TradeLogRow[] {
  if (!tableExists(db, 'perp_trades')) {
    return [];
  }
  const hasExecutionMode = tableHasColumn(db, 'perp_trades', 'execution_mode');
  if (!hasExecutionMode && filters.mode === 'live') {
    // Legacy perp_trades rows without execution_mode are treated as paper.
    return [];
  }
  const rows = hasExecutionMode
    ? (db
        .prepare(
          `
            SELECT id, symbol, side, status, created_at as createdAt, execution_mode
            FROM perp_trades
            WHERE (? IS NULL OR execution_mode = ?)
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `
        )
        .all(
          filters.mode === 'combined' ? null : filters.mode,
          filters.mode === 'combined' ? null : filters.mode,
          Math.max(1, Math.min(limit, 100))
        ) as Array<Record<string, unknown>>)
    : (db
        .prepare(
          `
            SELECT id, symbol, side, status, created_at as createdAt
            FROM perp_trades
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `
        )
        .all(Math.max(1, Math.min(limit, 100))) as Array<Record<string, unknown>>);

  return rows.map((row) => {
    const status = String(row.status ?? '')
      .trim()
      .toLowerCase();
    const sideRaw = String(row.side ?? '')
      .trim()
      .toLowerCase();
    const side: 'buy' | 'sell' | null = sideRaw === 'buy' || sideRaw === 'sell' ? sideRaw : null;
    const outcome: TradeLogRow['outcome'] =
      status === 'failed' || status === 'blocked' ? (status as 'failed' | 'blocked') : 'executed';
    return {
      tradeId: Number.isFinite(Number(row.id)) ? Number(row.id) : null,
      symbol: String(row.symbol ?? '').toUpperCase(),
      side,
      signalClass: null,
      outcome,
      directionScore: null,
      timingScore: null,
      sizingScore: null,
      exitScore: null,
      rCaptured: null,
      thesisCorrect: null,
      qualityBand: 'unknown',
      closedAt: String(row.createdAt ?? new Date().toISOString()),
    };
  });
}

type PromotionGateRow = {
  setupKey: string;
  sampleCount: number;
  hitRate: number;
  expectancyR: number;
  payoffRatio: number;
  maxDrawdownR: number;
  promoted: boolean;
  gates: {
    minTrades: { pass: boolean; required: number; actual: number; missing: number };
    maxDrawdownR: { pass: boolean; maxAllowed: number; actual: number; missing: number };
    minHitRate: { pass: boolean; required: number; actual: number; missing: number };
    minPayoffRatio: { pass: boolean; required: number; actual: number; missing: number };
    minExpectancyR: { pass: boolean; required: number; actual: number; missing: number };
  };
};

const DEFAULT_PROMOTION_GATES = {
  minTrades: 25,
  maxDrawdownR: 6,
  minHitRate: 0.5,
  minPayoffRatio: 1.2,
  minExpectancyR: 0.1,
};

function listPromotionGateRows(
  db: Database.Database,
  filters: DashboardFilters
): PromotionGateRow[] {
  if (!tableExists(db, 'decision_artifacts')) {
    return [];
  }

  const artifactRows = db
    .prepare(
      `
        SELECT payload
        FROM decision_artifacts
        WHERE kind = 'perp_trade_journal'
        ORDER BY created_at DESC
        LIMIT 500
      `
    )
    .all() as Array<{ payload?: string }>;

  const entries = artifactRows
    .map((row) => {
      if (!row.payload) return null;
      try {
        const parsedPayload = JSON.parse(row.payload) as Record<string, unknown>;
        if (!journalModeMatches(parsedPayload, filters)) {
          return null;
        }
        const parsed = parsedPayload as Partial<PerpTradeJournalEntry>;
        if (parsed.kind !== 'perp_trade_journal') {
          return null;
        }
        if (typeof parsed.symbol !== 'string' || !parsed.symbol.trim()) {
          return null;
        }
        const outcome = String(parsed.outcome ?? '').toLowerCase();
        if (outcome !== 'executed' && outcome !== 'failed' && outcome !== 'blocked') {
          return null;
        }
        return parsed as PerpTradeJournalEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is PerpTradeJournalEntry => entry != null);

  const keys = new Set<string>();
  for (const entry of entries) {
    const outcome = String(entry.outcome ?? '').toLowerCase();
    if ((outcome !== 'executed' && outcome !== 'failed') || !entry.symbol) {
      continue;
    }
    const signalClass =
      typeof entry.signalClass === 'string' && entry.signalClass.trim().length > 0
        ? entry.signalClass.trim()
        : typeof (entry as { signal_class?: unknown }).signal_class === 'string' &&
            String((entry as { signal_class?: unknown }).signal_class).trim().length > 0
          ? String((entry as { signal_class?: unknown }).signal_class).trim()
          : 'unknown';
    keys.add(`${String(entry.symbol).toUpperCase()}:${signalClass}`);
  }

  const rows: PromotionGateRow[] = [];
  for (const setupKey of keys) {
    const report = buildPaperPromotionReport({
      entries,
      setupKey,
      gates: DEFAULT_PROMOTION_GATES,
    });
    rows.push({
      setupKey: report.setupKey,
      sampleCount: report.sampleCount,
      hitRate: report.hitRate,
      expectancyR: report.expectancyR,
      payoffRatio: report.payoffRatio,
      maxDrawdownR: report.maxDrawdownR,
      promoted: report.promoted,
      gates: {
        minTrades: {
          pass: report.gates.minTrades.pass,
          required: report.gates.minTrades.required,
          actual: report.gates.minTrades.actual,
          missing: Math.max(0, report.gates.minTrades.required - report.gates.minTrades.actual),
        },
        maxDrawdownR: {
          pass: report.gates.maxDrawdownR.pass,
          maxAllowed: report.gates.maxDrawdownR.maxAllowed,
          actual: report.gates.maxDrawdownR.actual,
          missing: Math.max(0, report.gates.maxDrawdownR.actual - report.gates.maxDrawdownR.maxAllowed),
        },
        minHitRate: {
          pass: report.gates.minHitRate.pass,
          required: report.gates.minHitRate.required,
          actual: report.gates.minHitRate.actual,
          missing: Math.max(0, report.gates.minHitRate.required - report.gates.minHitRate.actual),
        },
        minPayoffRatio: {
          pass: report.gates.minPayoffRatio.pass,
          required: report.gates.minPayoffRatio.required,
          actual: report.gates.minPayoffRatio.actual,
          missing: Math.max(0, report.gates.minPayoffRatio.required - report.gates.minPayoffRatio.actual),
        },
        minExpectancyR: {
          pass: report.gates.minExpectancyR.pass,
          required: report.gates.minExpectancyR.required,
          actual: report.gates.minExpectancyR.actual,
          missing: Math.max(0, report.gates.minExpectancyR.required - report.gates.minExpectancyR.actual),
        },
      },
    });
  }

  return rows.sort((a, b) => {
    if (a.promoted !== b.promoted) return a.promoted ? 1 : -1;
    return b.sampleCount - a.sampleCount;
  });
}

type PerformanceBreakdownRow = {
  key: string;
  winRate: number;
  expectancyR: number;
  sampleCount: number;
};

function resolveJournalOutcome(payload: Record<string, unknown>): 'executed' | 'failed' | 'blocked' | 'unknown' {
  const raw = String(payload.outcome ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'executed' || raw === 'failed' || raw === 'blocked') {
    return raw;
  }
  return 'unknown';
}

function resolveJournalClosedAtMs(
  payload: Record<string, unknown>,
  createdAt: string | undefined
): number | null {
  const raw = String(payload.closedAt ?? createdAt ?? '');
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

function resolveSessionKey(timestampMs: number): string {
  const hour = new Date(timestampMs).getUTCHours();
  if (hour < 8) return 'asia';
  if (hour < 16) return 'europe';
  return 'us';
}

function resolveJournalExpectancyScore(payload: Record<string, unknown>): number {
  const r = Number(payload.capturedR ?? payload.captured_r);
  if (Number.isFinite(r)) {
    return r;
  }
  if (payload.thesisCorrect === true) return 1;
  if (payload.thesisCorrect === false) return -1;
  const outcome = resolveJournalOutcome(payload);
  if (outcome === 'failed') return -1;
  if (outcome === 'executed') return 0;
  return 0;
}

function resolveJournalWin(payload: Record<string, unknown>): boolean {
  const r = Number(payload.capturedR ?? payload.captured_r);
  if (Number.isFinite(r)) return r > 0;
  return payload.thesisCorrect === true;
}

function listPerformanceBreakdown(
  db: Database.Database,
  filters: DashboardFilters
): {
  bySignalClass: PerformanceBreakdownRow[];
  byRegime: PerformanceBreakdownRow[];
  bySession: PerformanceBreakdownRow[];
} {
  if (!tableExists(db, 'decision_artifacts')) {
    return { bySignalClass: [], byRegime: [], bySession: [] };
  }
  const rows = db
    .prepare(
      `
        SELECT payload, created_at as createdAt
        FROM decision_artifacts
        WHERE kind = 'perp_trade_journal'
        ORDER BY created_at DESC
        LIMIT 2000
      `
    )
    .all() as Array<{ payload?: string; createdAt?: string }>;
  const { fromMs, toMs } = resolveTimeRange(filters);

  const signalAgg = new Map<string, { sampleCount: number; wins: number; scoreSum: number }>();
  const regimeAgg = new Map<string, { sampleCount: number; wins: number; scoreSum: number }>();
  const sessionAgg = new Map<string, { sampleCount: number; wins: number; scoreSum: number }>();
  const add = (map: Map<string, { sampleCount: number; wins: number; scoreSum: number }>, key: string, win: boolean, score: number) => {
    const current = map.get(key) ?? { sampleCount: 0, wins: 0, scoreSum: 0 };
    current.sampleCount += 1;
    current.wins += win ? 1 : 0;
    current.scoreSum += score;
    map.set(key, current);
  };

  for (const row of rows) {
    if (!row.payload) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!journalModeMatches(payload, filters)) continue;
    const outcome = resolveJournalOutcome(payload);
    if (outcome !== 'executed' && outcome !== 'failed') continue;
    const closedAtMs = resolveJournalClosedAtMs(payload, row.createdAt);
    if (closedAtMs == null) continue;
    if ((fromMs != null && closedAtMs < fromMs) || (toMs != null && closedAtMs > toMs)) {
      continue;
    }
    const signalClass = resolveJournalSignalClass(payload) ?? 'unknown';
    const regime = resolveJournalMarketRegime(payload) ?? 'unknown';
    const session = resolveSessionKey(closedAtMs);
    const score = resolveJournalExpectancyScore(payload);
    const win = resolveJournalWin(payload);
    add(signalAgg, signalClass, win, score);
    add(regimeAgg, regime, win, score);
    add(sessionAgg, session, win, score);
  }

  const toRows = (
    map: Map<string, { sampleCount: number; wins: number; scoreSum: number }>
  ): PerformanceBreakdownRow[] =>
    [...map.entries()]
      .map(([key, value]) => ({
        key,
        winRate: value.sampleCount > 0 ? value.wins / value.sampleCount : 0,
        expectancyR: value.sampleCount > 0 ? value.scoreSum / value.sampleCount : 0,
        sampleCount: value.sampleCount,
      }))
      .sort((a, b) => b.sampleCount - a.sampleCount)
      .slice(0, 8);

  return {
    bySignalClass: toRows(signalAgg),
    byRegime: toRows(regimeAgg),
    bySession: toRows(sessionAgg),
  };
}

function countTradeJournalRows(
  db: Database.Database,
  filters: DashboardFilters
): number {
  if (filters.mode === 'combined') {
    return safeCount(
      db,
      "SELECT COUNT(*) AS c FROM decision_artifacts WHERE kind = 'perp_trade_journal'"
    );
  }

  const rows = db
    .prepare(
      `
        SELECT payload
        FROM decision_artifacts
        WHERE kind = 'perp_trade_journal'
      `
    )
    .all() as Array<{ payload?: string }>;
  let count = 0;
  for (const row of rows) {
    if (!row.payload) continue;
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (journalModeMatches(payload, filters)) {
        count += 1;
      }
    } catch {
      // ignore unparseable payloads
    }
  }
  return count;
}

function buildPolicyStateSection(db: Database.Database): {
  observationMode: boolean;
  leverageCap: number | null;
  drawdownCapRemainingUsd: number | null;
  tradesRemainingToday: number | null;
  updatedAt: string | null;
} {
  const defaults = {
    observationMode: false,
    leverageCap: null,
    drawdownCapRemainingUsd: null,
    tradesRemainingToday: null,
    updatedAt: null,
  } as const;

  if (!tableExists(db, 'autonomy_policy_state')) {
    return defaults;
  }

  let observationOnlyUntilMsRaw: unknown = null;
  let leverageCapRawInput: unknown = null;
  let drawdownCapRemainingUsdRaw: unknown = null;
  let tradesRemainingTodayRaw: unknown = null;
  let updatedAtRaw: unknown = null;
  try {
    if (tableHasColumn(db, 'autonomy_policy_state', 'payload')) {
      const row = db
        .prepare(
          `
            SELECT payload, updated_at as updatedAt
            FROM autonomy_policy_state
            ORDER BY id DESC
            LIMIT 1
          `
        )
        .get() as { payload?: string | null; updatedAt?: string | null } | undefined;
      if (!row) return defaults;
      updatedAtRaw = row.updatedAt ?? null;
      if (row.payload) {
        try {
          const payload = JSON.parse(row.payload) as Record<string, unknown>;
          observationOnlyUntilMsRaw =
            payload.observationOnlyUntilMs ?? payload.observation_only_until_ms ?? null;
          leverageCapRawInput =
            payload.leverageCapOverride ?? payload.leverage_cap_override ?? payload.leverageCap ?? null;
          drawdownCapRemainingUsdRaw =
            payload.drawdownCapRemainingUsd ??
            payload.drawdown_cap_remaining_usd ??
            payload.drawdownRemainingUsd ??
            null;
          tradesRemainingTodayRaw =
            payload.tradesRemainingToday ??
            payload.trades_remaining_today ??
            payload.tradesRemaining ??
            null;
        } catch {
          observationOnlyUntilMsRaw = null;
          leverageCapRawInput = null;
          drawdownCapRemainingUsdRaw = null;
          tradesRemainingTodayRaw = null;
        }
      }
    } else {
      const row = db
        .prepare(
          `
            SELECT observation_only_until_ms as observationOnlyUntilMs,
                   leverage_cap_override as leverageCapOverride,
                   updated_at as updatedAt
            FROM autonomy_policy_state
            ORDER BY id DESC
            LIMIT 1
          `
        )
        .get() as {
          observationOnlyUntilMs?: number | null;
          leverageCapOverride?: number | null;
          updatedAt?: string | null;
        } | undefined;
      if (!row) return defaults;
      observationOnlyUntilMsRaw = row.observationOnlyUntilMs ?? null;
      leverageCapRawInput = row.leverageCapOverride ?? null;
      updatedAtRaw = row.updatedAt ?? null;
    }
  } catch {
    return defaults;
  }

  const nowMs = Date.now();
  const observationOnlyUntilMs = Number(observationOnlyUntilMsRaw ?? NaN);
  const observationMode = Number.isFinite(observationOnlyUntilMs) && observationOnlyUntilMs > nowMs;

  const leverageCapRaw = Number(leverageCapRawInput ?? NaN);
  const leverageCap = Number.isFinite(leverageCapRaw) ? leverageCapRaw : null;
  const payloadDrawdownCapRemainingRaw = Number(drawdownCapRemainingUsdRaw ?? NaN);
  const payloadDrawdownCapRemainingUsd = Number.isFinite(payloadDrawdownCapRemainingRaw)
    ? payloadDrawdownCapRemainingRaw
    : null;

  const config = getDashboardConfig();
  const maxTradesEnvRaw = Number(process.env.THUFIR_DASHBOARD_MAX_TRADES_PER_DAY ?? NaN);
  const maxTradesConfigRaw = Number(
    (config?.autonomy as { maxTradesPerDay?: unknown } | undefined)?.maxTradesPerDay ?? NaN
  );
  const configuredMaxTradesPerDay =
    Number.isFinite(maxTradesEnvRaw) && maxTradesEnvRaw > 0
      ? Math.floor(maxTradesEnvRaw)
      : Number.isFinite(maxTradesConfigRaw) && maxTradesConfigRaw > 0
        ? Math.floor(maxTradesConfigRaw)
        : null;

  let tradesRemainingToday =
    tradesRemainingTodayRaw == null
      ? null
      : Number.isFinite(Number(tradesRemainingTodayRaw))
        ? Number(tradesRemainingTodayRaw)
        : null;
  if (configuredMaxTradesPerDay != null) {
    const todayCount = safeCount(
      db,
      `
        SELECT COUNT(*) AS c
        FROM perp_trades
        WHERE status = 'executed'
          AND date(created_at) = date('now')
      `
    );
    tradesRemainingToday = Math.max(0, configuredMaxTradesPerDay - todayCount);
  }

  const drawdownCapEnvRaw = Number(process.env.THUFIR_DASHBOARD_DAILY_DRAWDOWN_CAP_USD ?? NaN);
  const drawdownCapConfigRaw = Number(
    (config?.autonomy as { dailyDrawdownCapUsd?: unknown } | undefined)?.dailyDrawdownCapUsd ?? NaN
  );
  const configuredDrawdownCapUsd =
    Number.isFinite(drawdownCapEnvRaw) && drawdownCapEnvRaw > 0
      ? drawdownCapEnvRaw
      : Number.isFinite(drawdownCapConfigRaw) && drawdownCapConfigRaw > 0
        ? drawdownCapConfigRaw
        : null;

  let drawdownCapRemainingUsd = payloadDrawdownCapRemainingUsd;
  if (configuredDrawdownCapUsd != null) {
    try {
      const rollup = getDailyPnLRollup();
      const totalPnl = Number(rollup.totalPnl ?? 0);
      const boundedTotalPnl = Number.isFinite(totalPnl) ? totalPnl : 0;
      const remaining = configuredDrawdownCapUsd + boundedTotalPnl;
      drawdownCapRemainingUsd = Math.max(0, Math.min(configuredDrawdownCapUsd, remaining));
    } catch {
      drawdownCapRemainingUsd = payloadDrawdownCapRemainingUsd;
    }
  }

  const drawdownCapRemainingUsdFinal = Number.isFinite(Number(drawdownCapRemainingUsd))
    ? Number(drawdownCapRemainingUsd)
    : null;

  return {
    observationMode,
    leverageCap,
    drawdownCapRemainingUsd: drawdownCapRemainingUsdFinal,
    tradesRemainingToday,
    updatedAt: updatedAtRaw ? String(updatedAtRaw) : null,
  };
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
      points: EquityPoint[];
      summary: {
        startEquity: number | null;
        endEquity: number | null;
        returnPct: number | null;
        maxDrawdownPct: number | null;
      };
    };
    openPositions: {
      rows: OpenPositionRow[];
      summary: {
        totalUnrealizedPnlUsd: number;
        longCount: number;
        shortCount: number;
      };
    };
    tradeLog: {
      rows: TradeLogRow[];
      limit: number;
    };
    promotionGates: {
      rows: PromotionGateRow[];
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
  const journals = countTradeJournalRows(db, filters);
  const alerts = safeCount(db, 'SELECT COUNT(*) AS c FROM alerts');
  const openPaperPositions = !isLiveMode(filters) && tableExists(db, 'paper_perp_positions')
    ? safeCount(db, 'SELECT COUNT(*) AS c FROM paper_perp_positions')
    : 0;
  const equityCurve = isPaperMode(filters) || filters.mode === 'combined'
    ? buildPaperEquitySeries(db, filters)
    : buildEmptyEquitySeries();
  const openPositionRows = isLiveMode(filters) ? [] : listPaperOpenPositionRows(db);
  const longCount = openPositionRows.filter((row) => row.side === 'long').length;
  const shortCount = openPositionRows.filter((row) => row.side === 'short').length;
  const totalUnrealizedPnlUsd = openPositionRows.reduce(
    (sum, row) => sum + row.unrealizedPnlUsd,
    0
  );
  let tradeLogRows = listTradeLogRows(db, filters, 30);
  if (tradeLogRows.length === 0) {
    tradeLogRows = listTradeLogRowsFromPerpTrades(db, filters, 30);
  }
  const promotionGateRows = listPromotionGateRows(db, filters);
  const policyState = buildPolicyStateSection(db);
  const performanceBreakdown = listPerformanceBreakdown(db, filters);

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
      equityCurve,
      openPositions: {
        rows: openPositionRows,
        summary: {
          totalUnrealizedPnlUsd,
          longCount,
          shortCount,
        },
      },
      tradeLog: {
        rows: tradeLogRows,
        limit: 30,
      },
      promotionGates: {
        rows: promotionGateRows,
      },
      policyState: {
        observationMode: policyState.observationMode,
        leverageCap: policyState.leverageCap,
        drawdownCapRemainingUsd: policyState.drawdownCapRemainingUsd,
        tradesRemainingToday: policyState.tradesRemainingToday,
        updatedAt: policyState.updatedAt,
      },
      performanceBreakdown: {
        bySignalClass: performanceBreakdown.bySignalClass,
        byRegime: performanceBreakdown.byRegime,
        bySession: performanceBreakdown.bySession,
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
    if (!isLiveMode(filters)) {
      writeJson(res, 200, payload);
      return true;
    }

    // Live mode: overlay latest wallet snapshot from Hyperliquid when credentials are available.
    // If unavailable, return the DB-backed payload as-is.
    const baseConfig = (req as IncomingMessage & { thufirConfig?: ThufirConfig }).thufirConfig;
    if (!baseConfig) {
      writeJson(res, 200, payload);
      return true;
    }
    void tryBuildLiveWalletSnapshot(baseConfig)
      .then((snapshot) => {
        if (!snapshot) {
          writeJson(res, 200, payload);
          return;
        }
        writeJson(res, 200, {
          ...payload,
          sections: {
            ...payload.sections,
            equityCurve: snapshot.equityCurve,
            openPositions: snapshot.openPositions,
          },
        });
      })
      .catch(() => {
        writeJson(res, 200, payload);
      });
    return true;
  }

  writeJson(res, 404, { ok: false, error: 'Not found' });
  return true;
}
