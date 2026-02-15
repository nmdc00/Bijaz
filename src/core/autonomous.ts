/**
 * Autonomous Mode Manager
 *
 * Handles fully autonomous trading:
 * - On/off toggle
 * - Auto-execute trades when edge detected
 * - Track P&L and generate daily reports
 * - Pause on loss streaks
 */

import { EventEmitter } from 'eventemitter3';
import type { LlmClient } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { MarketClient } from '../execution/market-client.js';
import type { ExecutionAdapter, TradeDecision } from '../execution/executor.js';
import { DbSpendingLimitEnforcer } from '../execution/wallet/limits_db.js';
import { runDiscovery } from '../discovery/engine.js';
import type { ExpressionPlan } from '../discovery/types.js';
import { recordPerpTrade } from '../memory/perp_trades.js';
import { recordPerpTradeJournal } from '../memory/perp_trade_journal.js';
import { checkPerpRiskLimits } from '../execution/perp-risk.js';
import { getDailyPnLRollup } from './daily_pnl.js';
import { openDatabase } from '../memory/db.js';
import { listOpenPositionsFromTrades } from '../memory/trades.js';
import { Logger } from './logger.js';
import { buildTradeEnvelopeFromExpression } from '../trade-management/envelope.js';
import {
  countTradeEntriesToday,
  getLastCloseForSymbol,
  listOpenTradeEnvelopes,
  listRecentClosePnl,
  recordTradeEnvelope,
  recordTradeSignals,
} from '../trade-management/db.js';
import { placeExchangeSideTpsl } from '../trade-management/hyperliquid-stops.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import { buildTradeJournalSummary } from '../trade-management/summary.js';
import { reconcileEntryFill } from '../trade-management/reconcile.js';
import { createHyperliquidCloid } from '../execution/hyperliquid/cloid.js';

export interface AutonomousConfig {
  enabled: boolean;
  fullAuto: boolean;
  minEdge: number;
  requireHighConfidence: boolean;
  pauseOnLossStreak: number;
  dailyReportTime: string;
  maxTradesPerScan: number;
}

export interface DailyPnL {
  date: string;
  tradesExecuted: number;
  wins: number;
  losses: number;
  pending: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export interface AutonomousEvents {
  'daily-report': (report: string) => void;
  'paused': (reason: string) => void;
  'resumed': () => void;
  'error': (error: Error) => void;
}

export class AutonomousManager extends EventEmitter<AutonomousEvents> {
  private config: AutonomousConfig;
  private marketClient: MarketClient;
  private executor: ExecutionAdapter;
  private limiter: DbSpendingLimitEnforcer;
  private logger: Logger;
  private thufirConfig: ThufirConfig;
  private llm: LlmClient;

  private isPaused = false;
  private pauseReason = '';
  private consecutiveLosses = 0;
  private scanTimer: NodeJS.Timeout | null = null;
  private reportTimer: NodeJS.Timeout | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  // Lightweight pulse-based volatility proxy updated on each scan.
  private midPulse = new Map<string, { px: number; ts: number; pulsePct: number }>();
  private lastGlobalPulsePct = 0;

  constructor(
    llm: LlmClient,
    marketClient: MarketClient,
    executor: ExecutionAdapter,
    limiter: DbSpendingLimitEnforcer,
    thufirConfig: ThufirConfig,
    logger?: Logger
  ) {
    super();
    this.llm = llm;
    this.marketClient = marketClient;
    this.executor = executor;
    this.limiter = limiter;
    this.thufirConfig = thufirConfig;
    this.logger = logger ?? new Logger('info');

    // Load autonomous config with defaults
    this.config = {
      enabled: thufirConfig.autonomy?.enabled ?? false,
      fullAuto: (thufirConfig.autonomy as any)?.fullAuto ?? false,
      minEdge: (thufirConfig.autonomy as any)?.minEdge ?? 0.05,
      requireHighConfidence: (thufirConfig.autonomy as any)?.requireHighConfidence ?? false,
      pauseOnLossStreak: (thufirConfig.autonomy as any)?.pauseOnLossStreak ?? 3,
      dailyReportTime: (thufirConfig.autonomy as any)?.dailyReportTime ?? '20:00',
      maxTradesPerScan: (thufirConfig.autonomy as any)?.maxTradesPerScan ?? 3,
    };

    this.ensureTradesTable();
  }

  /**
   * Start autonomous mode
   */
  start(): void {
    if (!this.config.enabled) {
      this.logger.info('Autonomous mode is disabled in config');
      return;
    }

    this.stopped = false;
    // Start scheduled scanning (adaptive cadence).
    this.scheduleNextScan(1);

    // Schedule daily report
    this.scheduleDailyReport();

    const scanInterval = this.thufirConfig.autonomy?.scanIntervalSeconds ?? 900;
    this.logger.info(
      `Autonomous mode started. Full auto: ${this.config.fullAuto}. Base scan interval: ${scanInterval}s`
    );
  }

  /**
   * Stop autonomous mode
   */
  stop(): void {
    this.stopped = true;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.reportTimer) {
      clearTimeout(this.reportTimer);
      this.reportTimer = null;
    }
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    this.logger.info('Autonomous mode stopped');
  }

  private scheduleNextScan(delaySeconds: number): void {
    if (this.stopped) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.runScan()
        .catch((error) => {
          this.logger.error('Autonomous scan failed', error);
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          const next = this.decideCadenceSeconds();
          this.scheduleNextScan(next);
        });
    }, Math.max(1, delaySeconds) * 1000);
  }

  private decideCadenceSeconds(): number {
    const base = Number(this.thufirConfig.autonomy?.scanIntervalSeconds ?? 900);
    const min = 120;
    const max = 3600;
    const tmCfg = this.thufirConfig.tradeManagement;
    const openCount = tmCfg?.enabled ? listOpenTradeEnvelopes().length : listOpenPositionsFromTrades().length;
    const maxConcurrent = Number(tmCfg?.antiOvertrading?.maxConcurrentPositions ?? 2);
    const remaining = this.limiter.getRemainingDaily();
    const perTrade = Number(this.thufirConfig.wallet?.limits?.perTrade ?? 25);

    let mult = 1.0;
    if (openCount >= maxConcurrent) {
      // No capacity: slow down entry scans; management runs elsewhere.
      mult *= 2.0;
    }
    if (remaining < perTrade) {
      // Too little budget to do anything meaningful; slow down.
      mult *= 2.0;
    }
    if (this.lastGlobalPulsePct >= 1.0) {
      // High volatility: prefer fewer, more selective entry cycles.
      mult *= 1.5;
    } else if (this.lastGlobalPulsePct > 0 && this.lastGlobalPulsePct <= 0.25) {
      // Quiet regime: scan a bit more often to catch breakouts.
      mult *= 0.75;
    }

    const raw = base * mult;
    return Math.round(Math.min(max, Math.max(min, raw)));
  }

  private decideMaxTradesThisScan(): number {
    const base = Math.max(0, Math.floor(this.config.maxTradesPerScan));
    if (base <= 1) return base;
    // In high volatility, prefer selectivity: reduce the number of new positions per scan.
    if (this.lastGlobalPulsePct >= 1.0) return 1;
    return base;
  }

  private decideLeverage(params: {
    expectedEdge: number;
    confidence: number;
    volatilityPulsePct: number;
    fundingRate: number;
    side: 'buy' | 'sell';
    marketMaxLeverage: number | null;
  }): number {
    const walletMax = Number(this.thufirConfig.wallet?.perps?.maxLeverage ?? 5);
    const marketMax = params.marketMaxLeverage ?? walletMax;
    const cap = Math.max(1, Math.min(walletMax, marketMax));

    // Base selection: leverage is a margin-efficiency knob, not a "bet size" knob.
    // Keep it low by default for capital accumulation.
    let lev = 1;
    if (params.expectedEdge >= 0.08 && params.confidence >= 0.75) lev = 3;
    else if (params.expectedEdge >= 0.06 && params.confidence >= 0.65) lev = 2;

    // Volatility penalty.
    if (params.volatilityPulsePct >= 1.0) lev = Math.max(1, lev - 1);

    // Funding penalty: if funding is materially against the position, reduce leverage.
    const fundingAgainst =
      (params.side === 'buy' && params.fundingRate > 0) || (params.side === 'sell' && params.fundingRate < 0);
    if (fundingAgainst && Math.abs(params.fundingRate) >= 0.0001) lev = Math.max(1, lev - 1);

    return Math.min(cap, Math.max(1, lev));
  }

  /**
   * Pause autonomous trading
   */
  pause(reason: string): void {
    this.isPaused = true;
    this.pauseReason = reason;
    this.emit('paused', reason);
    this.logger.info(`Autonomous trading paused: ${reason}`);
  }

  /**
   * Resume autonomous trading
   */
  resume(): void {
    this.isPaused = false;
    this.pauseReason = '';
    this.consecutiveLosses = 0;
    this.emit('resumed');
    this.logger.info('Autonomous trading resumed');
  }

  /**
   * Get current status
   */
  getStatus(): {
    enabled: boolean;
    fullAuto: boolean;
    isPaused: boolean;
    pauseReason: string;
    consecutiveLosses: number;
    remainingDaily: number;
  } {
    return {
      enabled: this.config.enabled,
      fullAuto: this.config.fullAuto,
      isPaused: this.isPaused,
      pauseReason: this.pauseReason,
      consecutiveLosses: this.consecutiveLosses,
      remainingDaily: this.limiter.getRemainingDaily(),
    };
  }

  /**
   * Toggle full auto mode
   */
  setFullAuto(enabled: boolean): void {
    this.config.fullAuto = enabled;
    this.logger.info(`Full auto mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Run a scan and optionally execute trades
   */
  async runScan(): Promise<string> {
    if (this.isPaused) {
      return `Autonomous trading is paused: ${this.pauseReason}`;
    }

    const remaining = this.limiter.getRemainingDaily();
    if (remaining <= 0) {
      return 'Daily spending limit reached. No trades executed.';
    }

    await this.updateVolatilityPulse().catch(() => {});
    return this.runDiscoveryScan();
  }

  private async updateVolatilityPulse(): Promise<void> {
    // Only used to adjust cadence/leverage heuristics. Best-effort.
    if (this.thufirConfig.execution?.provider !== 'hyperliquid') return;
    const client = new HyperliquidClient(this.thufirConfig);
    const mids = await client.getAllMids();
    const now = Date.now();

    const watch = ['BTC', 'ETH'];
    let global = 0;
    for (const symbol of watch) {
      const px = Number(mids[symbol]);
      if (!Number.isFinite(px) || px <= 0) continue;
      const prev = this.midPulse.get(symbol) ?? null;
      const pulsePct = prev && prev.px > 0 ? (Math.abs(px - prev.px) / prev.px) * 100 : 0;
      this.midPulse.set(symbol, { px, ts: now, pulsePct });
      if (pulsePct > global) global = pulsePct;
    }
    this.lastGlobalPulsePct = global;
  }

  private async runDiscoveryScan(): Promise<string> {
    const tm = this.thufirConfig.tradeManagement;
    if (tm?.enabled) {
      const lossCfg = tm.antiOvertrading?.lossStreakPause;
      const streakN = Number(lossCfg?.consecutiveLosses ?? 0);
      const pauseSeconds = Number(lossCfg?.pauseSeconds ?? 0);
      if (!this.isPaused && streakN > 0 && pauseSeconds > 0) {
        const recent = listRecentClosePnl(Math.max(10, streakN + 2));
        let streak = 0;
        for (const row of recent) {
          if (row.pnlUsd > 0) break;
          streak += 1;
          if (streak >= streakN) break;
        }
        if (streak >= streakN) {
          this.pause(`Loss streak pause triggered (${streak}/${streakN})`);
          this.pauseTimer = setTimeout(() => this.resume(), pauseSeconds * 1000);
          return `Autonomous trading paused for ${pauseSeconds}s due to loss streak (${streak}/${streakN}).`;
        }
      }
    }

    const result = await runDiscovery(this.thufirConfig);
    if (result.expressions.length === 0) {
      return 'No discovery expressions generated.';
    }

    if (!this.config.fullAuto) {
      const top = result.expressions.slice(0, 5);
      const lines = top.map(
        (expr) =>
          `- ${expr.symbol} ${expr.side} probe=${expr.probeSizeUsd.toFixed(2)} leverage=${expr.leverage} (${expr.expectedMove})`
      );
      return `Discovery scan completed:\n${lines.join('\n')}`;
    }

    const eligible = result.expressions.filter((expr) => {
      if (expr.expectedEdge < this.config.minEdge) {
        return false;
      }
      if (this.config.requireHighConfidence && expr.confidence < 0.7) {
        return false;
      }
      return true;
    });
    if (eligible.length === 0) {
      return 'No expressions met autonomy thresholds (minEdge/confidence).';
    }

    const maxTradesThisScan = this.decideMaxTradesThisScan();
    const toExecute = await this.selectExpressionsToExecute(eligible, maxTradesThisScan);
    const outputs: string[] = [];
    let cachedEquityUsd: number | null = null;
    let equityFetched = false;
    let fundingBySymbol: Map<string, number> | null = null;

    for (const expr of toExecute) {
      const tmCfg = this.thufirConfig.tradeManagement;
      if (tmCfg?.enabled) {
        const openCount = listOpenTradeEnvelopes().length;
        const maxConcurrent = Number(tmCfg.antiOvertrading?.maxConcurrentPositions ?? 2);
        if (openCount >= maxConcurrent) {
          outputs.push(`${expr.symbol}: Skipped (max concurrent positions reached: ${openCount}/${maxConcurrent})`);
          continue;
        }

        const dailyCap = Number(tmCfg.antiOvertrading?.maxDailyEntries ?? 0);
        if (dailyCap > 0) {
          const today = countTradeEntriesToday();
          if (today >= dailyCap) {
            outputs.push(`${expr.symbol}: Skipped (daily entry cap reached: ${today}/${dailyCap})`);
            continue;
          }
        }

        const cooldown = Number(tmCfg.antiOvertrading?.cooldownAfterCloseSeconds ?? 0);
        if (cooldown > 0) {
          const symbolNorm = expr.symbol.includes('/') ? expr.symbol.split('/')[0]! : expr.symbol;
          const lastClose = getLastCloseForSymbol(symbolNorm.toUpperCase());
          if (lastClose) {
            const ageSec = (Date.now() - Date.parse(lastClose.closedAt)) / 1000;
            if (Number.isFinite(ageSec) && ageSec >= 0 && ageSec < cooldown) {
              outputs.push(`${expr.symbol}: Skipped (cooldown active: ${Math.round(ageSec)}s/${cooldown}s)`);
              continue;
            }
          }
        }
      }

      const symbol = expr.symbol.includes('/') ? expr.symbol.split('/')[0]! : expr.symbol;
      const market = await this.marketClient.getMarket(symbol);
      const markPrice = market.markPrice ?? 0;
      const symbolNorm = symbol.toUpperCase();
      let probeUsd = Math.min(expr.probeSizeUsd, this.limiter.getRemainingDaily());
      if (probeUsd <= 0) {
        outputs.push(`${symbol}: Skipped (insufficient daily budget)`);
        continue;
      }

      // Risk-based sizing (live mode): cap account equity risk per trade.
      const tmRiskCfg = this.thufirConfig.tradeManagement;
      const maxRiskPct = Number(tmRiskCfg?.maxAccountRiskPct ?? 0);
      const stopLossPct = Number(expr.stopLossPct ?? tmRiskCfg?.defaults?.stopLossPct ?? 3.0);
      if (
        maxRiskPct > 0 &&
        stopLossPct > 0 &&
        this.thufirConfig.execution?.mode === 'live' &&
        this.thufirConfig.execution?.provider === 'hyperliquid'
      ) {
        try {
          if (!equityFetched) {
            equityFetched = true;
            const client = new HyperliquidClient(this.thufirConfig);
            const state = (await client.getClearinghouseState()) as any;
            const raw = state?.marginSummary?.accountValue ?? state?.crossMarginSummary?.accountValue ?? null;
            const num = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
            cachedEquityUsd = Number.isFinite(num) && num > 0 ? num : null;
          }
          if (cachedEquityUsd != null) {
            const maxLossUsd = (maxRiskPct / 100) * cachedEquityUsd;
            const capNotional = maxLossUsd / (stopLossPct / 100);
            if (Number.isFinite(capNotional) && capNotional > 0) {
              probeUsd = Math.min(probeUsd, capNotional);
            }
          }
        } catch {
          // Best-effort; if equity fetch fails, proceed with the probe size.
        }
      }
      const size = markPrice > 0 ? probeUsd / markPrice : probeUsd;
      const marketMaxLeverage =
        typeof market.metadata?.maxLeverage === 'number'
          ? (market.metadata.maxLeverage as number)
          : null;

      // Resolve funding rate best-effort (used as a penalty when it is against the position).
      let fundingRate = 0;
      if (this.thufirConfig.execution?.mode === 'live' && this.thufirConfig.execution?.provider === 'hyperliquid') {
        try {
          if (!fundingBySymbol) {
            fundingBySymbol = new Map<string, number>();
            const client = new HyperliquidClient(this.thufirConfig);
            const resp = (await client.getMetaAndAssetCtxs()) as any;
            const meta = Array.isArray(resp) ? resp[0] : null;
            const ctxs = Array.isArray(resp) ? resp[1] : null;
            const universe = Array.isArray(meta?.universe) ? meta.universe : [];
            const assetCtxs = Array.isArray(ctxs) ? ctxs : [];
            for (let i = 0; i < universe.length; i++) {
              const sym = String(universe[i]?.name ?? '').trim().toUpperCase();
              if (!sym) continue;
              const ctx = assetCtxs[i] ?? {};
              const raw = (ctx as any).funding ?? (ctx as any).fundingRate ?? (ctx as any).fundingRatePerHour ?? 0;
              const num = Number(raw);
              fundingBySymbol.set(sym, Number.isFinite(num) ? num : 0);
            }
          }
          fundingRate = fundingBySymbol.get(symbolNorm) ?? 0;
        } catch {
          fundingRate = 0;
        }
      }

      const volPulsePct = this.midPulse.get(symbolNorm)?.pulsePct ?? this.lastGlobalPulsePct ?? 0;
      const leverage = this.decideLeverage({
        expectedEdge: Number(expr.expectedEdge ?? 0),
        confidence: Number(expr.confidence ?? 0),
        volatilityPulsePct: Number.isFinite(volPulsePct) ? volPulsePct : 0,
        fundingRate: Number.isFinite(fundingRate) ? fundingRate : 0,
        side: expr.side,
        marketMaxLeverage,
      });

      const riskCheck = await checkPerpRiskLimits({
        config: this.thufirConfig,
        symbol,
        side: expr.side,
        size,
        leverage,
        reduceOnly: false,
        markPrice: markPrice || null,
        notionalUsd: Number.isFinite(probeUsd) ? probeUsd : undefined,
        marketMaxLeverage,
      });
      if (!riskCheck.allowed) {
        outputs.push(`${symbol}: Blocked (${riskCheck.reason ?? 'perp risk limits exceeded'})`);
        continue;
      }

      const limitCheck = await this.limiter.checkAndReserve(probeUsd);
      if (!limitCheck.allowed) {
        outputs.push(`${symbol}: Blocked (${limitCheck.reason})`);
        continue;
      }

      const decision: TradeDecision = {
        action: expr.side,
        side: expr.side,
        symbol,
        size,
        orderType: expr.orderType,
        leverage,
        clientOrderId: createHyperliquidCloid(),
        reasoning: `${expr.expectedMove} | edge=${(expr.expectedEdge * 100).toFixed(2)}% confidence=${(
          expr.confidence * 100
        ).toFixed(1)}% lev=${leverage} pulse=${(Number.isFinite(volPulsePct) ? volPulsePct : 0).toFixed(2)}%`,
      };
      const decisionStartMs = Date.now();

      const tradeResult = await this.executor.execute(market, decision);
      if (tradeResult.executed) {
        this.limiter.confirm(probeUsd);
      } else {
        this.limiter.release(probeUsd);
      }
      try {
        const tradeId = recordPerpTrade({
          hypothesisId: expr.hypothesisId,
          symbol,
          side: expr.side,
          size,
          price: markPrice || null,
          leverage,
          orderType: expr.orderType,
          status: tradeResult.executed ? 'executed' : 'failed',
        });
        recordPerpTradeJournal({
          kind: 'perp_trade_journal',
          tradeId,
          hypothesisId: expr.hypothesisId ?? null,
          symbol,
          side: expr.side,
          size,
          leverage: leverage ?? null,
          orderType: expr.orderType ?? null,
          reduceOnly: false,
          markPrice: markPrice || null,
          confidence: expr.confidence != null ? String(expr.confidence) : null,
          reasoning: decision.reasoning ?? null,
          outcome: tradeResult.executed ? 'executed' : 'failed',
          message: tradeResult.message,
        });

        if (tradeResult.executed && typeof markPrice === 'number' && markPrice > 0) {
          let entryPrice = markPrice;
          let entryFeesUsd: number | null = null;
          if (decision.clientOrderId && this.thufirConfig.execution?.mode === 'live') {
            const rec = await reconcileEntryFill({
              config: this.thufirConfig,
              symbol,
              entryCloid: decision.clientOrderId,
              startTimeMs: decisionStartMs,
            });
            if (rec.avgPx != null) entryPrice = rec.avgPx;
            entryFeesUsd = rec.feesUsd;
          }
          const envelope = buildTradeEnvelopeFromExpression({
            config: this.thufirConfig,
            tradeId: `perp_${tradeId}`,
            expr,
            entryPrice,
            size,
            notionalUsd: probeUsd,
            entryCloid: decision.clientOrderId ?? null,
            entryFeesUsd,
          });
          recordTradeEnvelope(envelope);
          recordTradeSignals({
            tradeId: envelope.tradeId,
            symbol: envelope.symbol,
            signals: (expr.signalKinds ?? []).map((kind: string) => ({ kind })),
          });

          const stops = await placeExchangeSideTpsl({ config: this.thufirConfig, envelope });
          if (stops.tpOid || stops.slOid) {
            envelope.tpOid = stops.tpOid;
            envelope.slOid = stops.slOid;
            recordTradeEnvelope(envelope);
          }
        }
      } catch {
        // Best-effort journaling: never block trading due to local DB issues.
      }
      outputs.push(tradeResult.message);
    }

    return outputs.join('\n');
  }

  private async selectExpressionsToExecute(
    eligible: ExpressionPlan[],
    maxTrades: number
  ): Promise<ExpressionPlan[]> {
    if (maxTrades <= 0) return [];
    if (eligible.length <= maxTrades) return eligible;
    if (this.thufirConfig.tradeManagement?.enabled !== true) {
      return eligible.slice(0, maxTrades);
    }

    const journalSummary = buildTradeJournalSummary({ limit: 20 });
    const payload = {
      N: maxTrades,
      journalSummary,
      eligibleExpressions: eligible.map((e) => ({
        id: e.id,
        symbol: e.symbol,
        side: e.side,
        expectedEdge: e.expectedEdge,
        confidence: e.confidence,
        leverage: e.leverage,
        probeSizeUsd: e.probeSizeUsd,
        stopLossPct: e.stopLossPct ?? null,
        takeProfitPct: e.takeProfitPct ?? null,
        maxHoldSeconds: e.maxHoldSeconds ?? null,
        trailingStopPct: e.trailingStopPct ?? null,
        trailingActivationPct: e.trailingActivationPct ?? null,
        signalKinds: e.signalKinds ?? [],
        thesis: e.thesis ?? '',
      })),
    };

    const system =
      'You are selecting which (if any) expressions to execute in full autonomous mode.\n' +
      'Default state is NO TRADE. Most scans should result in no action.\n' +
      'Return ONLY JSON: {"selectedExpressionIds":[...], "rationale":"..."}.\n' +
      'Rules:\n' +
      '- Never select more than N.\n' +
      '- Prefer selectivity over action.\n';

    try {
      const res = await this.llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(payload, null, 2) },
        ],
        { temperature: 0.2, maxTokens: 600 }
      );
      const parsed = safeJson(res.content) as any;
      const ids = Array.isArray(parsed?.selectedExpressionIds)
        ? parsed.selectedExpressionIds.map((x: any) => String(x)).filter(Boolean)
        : [];
      if (ids.length === 0) return [];
      const allow = new Set(eligible.map((e) => e.id));
      const filtered = ids.filter((id: string) => allow.has(id)).slice(0, maxTrades);
      const byId = new Map(eligible.map((e) => [e.id, e] as const));
      return filtered.map((id: string) => byId.get(id)!).filter(Boolean);
    } catch (err) {
      this.logger.warn('LLM entry selection failed; falling back to top expressions', err);
      return eligible.slice(0, maxTrades);
    }
  }

  /**
   * Update trade outcome and track losses
   */
  updateTradeOutcome(tradeId: string, outcome: 'win' | 'loss', pnl: number): void {
    const db = openDatabase();
    db.prepare(`
      UPDATE autonomous_trades SET outcome = @outcome, pnl = @pnl WHERE id = @tradeId
    `).run({ tradeId, outcome, pnl });

    if (outcome === 'loss') {
      this.consecutiveLosses++;
    } else {
      this.consecutiveLosses = 0;
    }

    if (
      this.config.pauseOnLossStreak > 0 &&
      this.consecutiveLosses >= this.config.pauseOnLossStreak &&
      !this.isPaused
    ) {
      this.pause(
        `Loss streak threshold reached (${this.consecutiveLosses}/${this.config.pauseOnLossStreak})`
      );
    }
  }

  /**
   * Get today's P&L summary
   */
  getDailyPnL(): DailyPnL {
    const today = new Date().toISOString().split('T')[0] ?? new Date().toISOString().slice(0, 10);
    const db = openDatabase();

    const trades = db.prepare(`
      SELECT outcome, pnl FROM autonomous_trades
      WHERE date(timestamp) = @today
    `).all({ today }) as Array<{ outcome: string; pnl: number | null }>;

    const wins = trades.filter(t => t.outcome === 'win').length;
    const losses = trades.filter(t => t.outcome === 'loss').length;
    const pending = trades.filter(t => t.outcome === 'pending').length;
    const realizedPnl = trades
      .filter(t => t.pnl !== null)
      .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

    const unrealizedPnl = this.calculateUnrealizedPnl();

    return {
      date: today,
      tradesExecuted: trades.length,
      wins,
      losses,
      pending,
      realizedPnl,
      unrealizedPnl,
    };
  }

  /**
   * Generate daily P&L report
   */
  async generateDailyPnLReport(): Promise<string> {
    const pnl = this.getDailyPnL();
    const rollup = getDailyPnLRollup(pnl.date);
    const discovery = await runDiscovery(this.thufirConfig);
    const expressions = discovery.expressions.slice(0, 5);

    const lines: string[] = [];
    lines.push(`📈 **Daily Autonomous Trading Report** (${pnl.date})`);
    lines.push('');
    lines.push('**Today\'s Activity:**');
    lines.push(`• Trades executed: ${pnl.tradesExecuted}`);
    lines.push(`• Wins: ${pnl.wins} | Losses: ${pnl.losses} | Pending: ${pnl.pending}`);
    lines.push(`• Realized P&L: ${pnl.realizedPnl >= 0 ? '+' : ''}$${pnl.realizedPnl.toFixed(2)}`);
    lines.push('');
    lines.push('**Status:**');
    const status = this.getStatus();
    lines.push(`• Full auto: ${status.fullAuto ? 'ON' : 'OFF'}`);
    lines.push(`• Paused: ${status.isPaused ? `YES (${status.pauseReason})` : 'NO'}`);
    lines.push(`• Remaining daily budget: $${status.remainingDaily.toFixed(2)}`);
    lines.push('');
    lines.push('**PnL Rollup:**');
    lines.push(`• Realized: ${rollup.realizedPnl >= 0 ? '+' : ''}$${rollup.realizedPnl.toFixed(2)}`);
    lines.push(`• Unrealized: ${rollup.unrealizedPnl >= 0 ? '+' : ''}$${rollup.unrealizedPnl.toFixed(2)}`);
    lines.push(`• Total: ${rollup.totalPnl >= 0 ? '+' : ''}$${rollup.totalPnl.toFixed(2)}`);
    if (rollup.byDomain.length > 0) {
      lines.push('• By domain:');
      for (const row of rollup.byDomain) {
        lines.push(
          `  - ${row.domain}: ${row.totalPnl >= 0 ? '+' : ''}$${row.totalPnl.toFixed(2)}`
        );
      }
    }
    lines.push('');
    lines.push('**Discovery Snapshot:**');
    if (expressions.length === 0) {
      lines.push('• No discovery expressions generated.');
    } else {
      for (const expr of expressions) {
        lines.push(
          `• ${expr.symbol} ${expr.side.toUpperCase()} probe=$${expr.probeSizeUsd.toFixed(2)} leverage=${expr.leverage}`
        );
      }
    }

    return lines.join('\n');
  }

  /**
   * Schedule the daily report
   */
  private scheduleDailyReport(): void {
    const scheduleNext = () => {
      const now = new Date();
      const timeParts = this.config.dailyReportTime.split(':').map(Number);
      const hours = timeParts[0] ?? 20;
      const minutes = timeParts[1] ?? 0;

      const target = new Date(now);
      target.setHours(hours, minutes, 0, 0);

      if (target <= now) {
        target.setDate(target.getDate() + 1);
      }

      const delay = target.getTime() - now.getTime();

      this.reportTimer = setTimeout(async () => {
        try {
          const report = await this.generateDailyPnLReport();
          this.emit('daily-report', report);
        } catch (error) {
          this.logger.error('Failed to generate daily report', error);
        }
        scheduleNext();
      }, delay);
    };

    scheduleNext();
  }

  private calculateUnrealizedPnl(): number {
    const positions = listOpenPositionsFromTrades(200);
    let total = 0;

    for (const position of positions) {
      const outcome = position.predictedOutcome ?? 'YES';
      const prices = position.currentPrices ?? null;
      let currentPrice: number | null = null;
      if (Array.isArray(prices)) {
        currentPrice = outcome === 'YES' ? prices[0] ?? null : prices[1] ?? null;
      } else if (prices) {
        currentPrice =
          prices[outcome] ??
          prices[outcome.toUpperCase()] ??
          prices[outcome.toLowerCase()] ??
          prices[outcome === 'YES' ? 'Yes' : 'No'] ??
          prices[outcome === 'YES' ? 'yes' : 'no'] ??
          null;
      }

      const averagePrice = position.executionPrice ?? currentPrice ?? 0;
      const positionSize = position.positionSize ?? 0;
      if (averagePrice <= 0 || positionSize <= 0) {
        continue;
      }
      const shares = positionSize / averagePrice;
      const price = currentPrice ?? averagePrice;
      const value = shares * price;
      total += value - positionSize;
    }

    return total;
  }

  /**
   * Ensure the trades table exists
   */
  private ensureTradesTable(): void {
    const db = openDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS autonomous_trades (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        market_title TEXT NOT NULL,
        direction TEXT NOT NULL,
        amount REAL NOT NULL,
        entry_price REAL NOT NULL,
        confidence TEXT,
        reasoning TEXT,
        timestamp TEXT NOT NULL,
        outcome TEXT DEFAULT 'pending',
        pnl REAL
      );

      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON autonomous_trades(timestamp);
      CREATE INDEX IF NOT EXISTS idx_trades_outcome ON autonomous_trades(outcome);
    `);
  }
}

function safeJson(text: string): unknown | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}
