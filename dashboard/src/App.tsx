import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { buildDashboardQuery, fetchDashboardSummary } from './api';
import type { DashboardMode, DashboardPayload, DashboardTimeframe } from './types';

const PERIODS = ['1d', '7d', '14d', '30d', '90d'];
const TABS = ['overview', 'positions', 'trades', 'performance', 'policy'] as const;
type DashboardTab = (typeof TABS)[number];

function money(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value));
}

function percent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return `${Number(value).toFixed(2)}%`;
}

function numberText(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return Number(value).toFixed(digits);
}

function timeText(value: string | null | undefined): string {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString();
}

function badgeClass(value: unknown): string {
  if (value === 'good' || value === 'long' || value === true) return 'badge good';
  if (value === 'poor' || value === 'bad' || value === 'short' || value === false) return 'badge bad';
  return 'badge mixed';
}

function EquityChart({ points }: { points: Array<{ timestamp: string; equity: number }> }) {
  if (!Array.isArray(points) || points.length === 0) {
    return <div className="empty-state">No equity points for this filter window.</div>;
  }
  const width = 960;
  const height = 320;
  const padding = 28;
  const values = points.map((point) => Number(point.equity)).filter((value) => Number.isFinite(value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const floor = Math.abs(max - min) < 1e-9 ? min - 1 : min;
  const ceil = Math.abs(max - min) < 1e-9 ? max + 1 : max;
  const xFor = (index: number) => padding + (index / Math.max(1, points.length - 1)) * (width - padding * 2);
  const yFor = (value: number) => padding + ((ceil - value) / Math.max(1e-9, ceil - floor)) * (height - padding * 2);
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(Number(point.equity))}`).join(' ');
  const area = `${line} L ${xFor(points.length - 1)} ${height - padding} L ${xFor(0)} ${height - padding} Z`;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return (
    <>
      <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Equity curve">
        <defs>
          <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(245,162,77,0.56)" />
            <stop offset="100%" stopColor="rgba(216,107,49,0.06)" />
          </linearGradient>
        </defs>
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="rgba(246,220,180,0.18)" />
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(246,220,180,0.18)" />
        <path d={area} fill="url(#equityFill)" />
        <path d={line} fill="none" stroke="#f6dcb4" strokeWidth="3" />
      </svg>
      <div className="line-chart-meta">
        <span>{timeText(first.timestamp)} · {money(first.equity)}</span>
        <span>{timeText(last.timestamp)} · {money(last.equity)}</span>
      </div>
    </>
  );
}

function DataTable({ headers, rows, empty }: { headers: string[]; rows: Array<Array<ReactNode>>; empty: string }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={headers.length} className="empty-state">{empty}</td></tr>
          ) : rows.map((row, index) => (
            <tr key={index}>{row.map((cell, cellIndex) => <td key={`${index}-${cellIndex}`}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PerfTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  return (
    <DataTable
      headers={['Key', 'Win Rate', 'Expectancy R', 'Samples']}
      empty="No data yet for this slice."
      rows={rows.slice(0, 8).map((row) => [
        String(row.key ?? row.label ?? row.name ?? '-'),
        <span className="mono">{percent((Number(row.winRate ?? row.hitRate ?? 0) || 0) * 100)}</span>,
        <span className="mono">{numberText(Number(row.expectancyR ?? row.expectancy ?? 0), 3)}</span>,
        <span className="mono">{numberText(Number(row.sampleCount ?? row.samples ?? 0), 0)}</span>,
      ])}
    />
  );
}

export default function App() {
  const [mode, setMode] = useState<DashboardMode>('paper');
  const [timeframe, setTimeframe] = useState<DashboardTimeframe>('all');
  const [period, setPeriod] = useState('30d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tab, setTab] = useState<DashboardTab>('overview');
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState('');

  const query = useMemo(() => ({ mode, timeframe, period, from, to }), [mode, timeframe, period, from, to]);
  const queryString = useMemo(() => buildDashboardQuery(query), [query]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const next = await fetchDashboardSummary(query);
        if (cancelled) return;
        setPayload(next);
        setRefreshedAt(new Date().toISOString());
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load dashboard');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    const handle = window.setInterval(() => void load(), mode === 'live' ? 5_000 : 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [query, queryString, mode]);

  const summary = payload?.sections.equityCurve.summary;
  const points = payload?.sections.equityCurve.points ?? [];
  const openPositions = payload?.sections.openPositions.rows ?? [];
  const openPositionSummary = payload?.sections.openPositions.summary;
  const tradeRows = payload?.sections.tradeLog.rows ?? [];
  const promotionRows = payload?.sections.promotionGates.rows ?? [];
  const policy = payload?.sections.policyState;
  const performance = payload?.sections.performanceBreakdown;

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-card">
          <p className="hero-eyebrow">Autonomous Market Discovery Companion</p>
          <h1>Thufir Dashboard v2</h1>
          <p>A product-grade control room for trading state, execution quality, and release health. The gateway now serves a real bundled frontend instead of CDN React.</p>
          <div className="hero-meta">
            <div className="hero-stat"><div className="hero-eyebrow">Generated</div><div className="hero-stat-value">{timeText(payload?.meta.generatedAt)}</div></div>
            <div className="hero-stat"><div className="hero-eyebrow">Refreshed</div><div className="hero-stat-value">{timeText(refreshedAt)}</div></div>
            <div className="hero-stat"><div className="hero-eyebrow">Mode</div><div className="hero-stat-value">{mode}</div></div>
            <div className="hero-stat"><div className="hero-eyebrow">Window</div><div className="hero-stat-value">{timeframe === 'period' ? period : timeframe}</div></div>
          </div>
        </div>
        <div className="hero-side">
          <div className={`hero-card status-banner ${error ? 'status-error' : 'status-okay'}`}>
            <strong>{error ? 'Data feed degraded' : 'Dashboard online'}</strong>
            <span>{error ? error : loading ? 'Refreshing the latest control-room snapshot.' : 'Static bundle is serving correctly and the gateway API is responding.'}</span>
          </div>
          <div className="hero-card status-banner">
            <strong>Foundation complete</strong>
            <span>Conversations and structured decision logs can now be added as real tabs on top of this build pipeline and static serving path.</span>
          </div>
        </div>
      </section>

      <section className="toolbar">
        <div className="filter-card"><label>Mode</label><select value={mode} onChange={(event) => setMode(event.target.value as DashboardMode)}><option value="paper">Paper</option><option value="live">Live</option><option value="combined">Combined</option></select></div>
        <div className="filter-card"><label>Timeframe</label><select value={timeframe} onChange={(event) => setTimeframe(event.target.value as DashboardTimeframe)}><option value="all">All</option><option value="day">Day</option><option value="period">Period</option><option value="custom">Custom</option></select></div>
        <div className="filter-card"><label>Period</label><select value={period} disabled={timeframe !== 'period'} onChange={(event) => setPeriod(event.target.value)}>{PERIODS.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
        <div className="filter-card"><label>From</label><input type="datetime-local" value={from} disabled={timeframe !== 'custom'} onChange={(event) => setFrom(event.target.value)} /></div>
        <div className="filter-card"><label>To</label><input type="datetime-local" value={to} disabled={timeframe !== 'custom'} onChange={(event) => setTo(event.target.value)} /></div>
      </section>

      <section className="tabs">
        {TABS.map((value) => (
          <button key={value} type="button" className={`tab-button ${tab === value ? 'active' : ''}`} onClick={() => setTab(value)}>
            {value}
          </button>
        ))}
      </section>

      <section className="kpi-grid">
        <article className="kpi-card"><div className="kpi-label">Account Equity</div><div className="kpi-value mono">{money(summary?.endEquity)}</div><div className="kpi-sub">Start {money(summary?.startEquity)}</div></article>
        <article className="kpi-card"><div className="kpi-label">Return</div><div className="kpi-value mono">{percent(summary?.returnPct)}</div><div className="kpi-sub">Max drawdown {percent(summary?.maxDrawdownPct)}</div></article>
        <article className="kpi-card"><div className="kpi-label">Open PnL</div><div className="kpi-value mono">{money(openPositionSummary?.totalUnrealizedPnlUsd)}</div><div className="kpi-sub">Long {numberText(openPositionSummary?.longCount, 0)} / Short {numberText(openPositionSummary?.shortCount, 0)}</div></article>
        <article className="kpi-card"><div className="kpi-label">Records</div><div className="kpi-value mono">{numberText(payload?.meta.recordCounts?.journals, 0)} journals</div><div className="kpi-sub">{numberText(payload?.meta.recordCounts?.perpTrades, 0)} trades · {numberText(payload?.meta.recordCounts?.alerts, 0)} alerts</div></article>
      </section>

      {tab === 'overview' && (
        <section className="content-grid">
          <article className="panel"><div className="panel-head"><h2>Equity Curve</h2><p>Cash and unrealized PnL over the selected filter window.</p></div><div className="panel-body chart-card"><EquityChart points={points} /></div></article>
          <article className="panel"><div className="panel-head"><h2>Policy State</h2><p>Execution guardrails and current risk posture.</p></div><div className="panel-body"><div className="subgrid"><div className="subpanel"><h3>Observation</h3><div className={badgeClass(policy?.observationMode)}>{policy?.observationMode ? 'ON' : 'OFF'}</div></div><div className="subpanel"><h3>Leverage Cap</h3><div className="mono">{policy?.leverageCap == null ? '-' : `${numberText(policy.leverageCap, 2)}x`}</div></div><div className="subpanel"><h3>Drawdown Left</h3><div className="mono">{money(policy?.drawdownCapRemainingUsd)}</div></div><div className="subpanel"><h3>Trades Remaining</h3><div className="mono">{numberText(policy?.tradesRemainingToday, 0)}</div></div></div><div className="footnote">Updated {timeText(policy?.updatedAt)}</div></div></article>
        </section>
      )}

      {tab === 'positions' && (
        <section className="panel"><div className="panel-head"><h2>Open Positions</h2><p>Current mark-to-market exposure for paper or live mode.</p></div><div className="panel-body"><DataTable headers={['Symbol', 'Side', 'Entry', 'Current', 'Size', 'Unrealized', 'Held']} empty="No open positions." rows={openPositions.map((row) => [String(row.symbol ?? '-'), <span className={badgeClass(row.side)}>{String(row.side ?? '-')}</span>, <span className="mono">{money(Number(row.entryPrice ?? 0))}</span>, <span className="mono">{money(Number(row.currentPrice ?? 0))}</span>, <span className="mono">{numberText(Number(row.size ?? 0), 4)}</span>, <span className="mono">{money(Number(row.unrealizedPnlUsd ?? 0))}</span>, <span className="mono">{numberText(Number(row.heldSeconds ?? 0) / 60, 1)}m</span>])} /></div></section>
      )}

      {tab === 'trades' && (
        <section className="panel"><div className="panel-head"><h2>Trade Log</h2><p>Recent scored journal rows with quality labels.</p></div><div className="panel-body"><DataTable headers={['Closed', 'Symbol', 'Side', 'Signal', 'R', 'Quality']} empty="No trade log rows." rows={tradeRows.map((row) => [<span className="mono">{timeText(String(row.closedAt ?? ''))}</span>, String(row.symbol ?? '-'), String(row.side ?? '-'), String(row.signalClass ?? 'unknown'), <span className="mono">{numberText(Number(row.rCaptured ?? 0), 3)}</span>, <span className={badgeClass(row.qualityBand)}>{String(row.qualityBand ?? 'mixed')}</span>])} /></div></section>
      )}

      {tab === 'performance' && (
        <section className="subgrid">
          <article className="subpanel"><h3>By Signal Class</h3><PerfTable rows={performance?.bySignalClass ?? []} /></article>
          <article className="subpanel"><h3>By Regime</h3><PerfTable rows={performance?.byRegime ?? []} /></article>
          <article className="subpanel"><h3>By Session</h3><PerfTable rows={performance?.bySession ?? []} /></article>
          <article className="subpanel"><h3>Promotion Gates</h3><DataTable headers={['Setup', 'Samples', 'Hit Rate', 'Expectancy', 'Promoted']} empty="No promotion rows." rows={promotionRows.map((row) => [String(row.setupKey ?? '-'), <span className="mono">{numberText(Number(row.sampleCount ?? 0), 0)}</span>, <span className="mono">{percent(Number(row.hitRate ?? 0) * 100)}</span>, <span className="mono">{numberText(Number(row.expectancyR ?? 0), 3)}</span>, <span className={badgeClass(Boolean(row.promoted))}>{row.promoted ? 'yes' : 'no'}</span>])} /></article>
        </section>
      )}

      {tab === 'policy' && (
        <section className="panel"><div className="panel-head"><h2>Policy Envelope</h2><p>Raw policy-state slice surfaced for release gates and execution control.</p></div><div className="panel-body"><pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(policy ?? {}, null, 2)}</pre></div></section>
      )}

      <div className="footnote">Polling cadence: {mode === 'live' ? '5 seconds' : '30 seconds'} · query `{queryString || '(none)'}`.</div>
    </main>
  );
}
