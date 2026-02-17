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
import { recordPerpTrade } from '../memory/perp_trades.js';
import { listPerpTradeJournals, recordPerpTradeJournal } from '../memory/perp_trade_journal.js';
import { checkPerpRiskLimits } from '../execution/perp-risk.js';
import { getDailyPnLRollup } from './daily_pnl.js';
import { openDatabase } from '../memory/db.js';
import { listOpenPositionsFromTrades, type OpenTradePosition } from '../memory/trades.js';
import { Logger } from './logger.js';
import {
  applyReflectionMutation,
  classifyMarketRegime,
  classifySignalClass,
  computeFractionalKellyFraction,
  evaluateGlobalTradeGate,
  evaluateNewsEntryGate,
  isSignalClassAllowedForRegime,
  resolveLiquidityBucket,
  resolveVolatilityBucket,
} from './autonomy_policy.js';
import { getAutonomyPolicyState } from '../memory/autonomy_policy_state.js';
import { summarizeSignalPerformance } from './signal_performance.js';
import { SchedulerControlPlane } from './scheduler_control_plane.js';
import { resolveSessionWeightContext } from './session-weight.js';

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function formatContextPackTrace(input: {
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
  executionStatus: string;
  eventKind: string;
  portfolioPosture: string;
  missing: string[];
}): string {
  const missing = input.missing.length > 0 ? input.missing.join(',') : 'none';
  return `context_pack{regime=${input.marketRegime};vol=${input.volatilityBucket};liq=${input.liquidityBucket};exec=${input.executionStatus};event=${input.eventKind};portfolio=${input.portfolioPosture};missing=${missing}}`;
}

export interface AutonomousConfig {
  enabled: boolean;
  fullAuto: boolean;
  minEdge: number;
  requireHighConfidence: boolean;
  pauseOnLossStreak: number;
  dailyReportTime: string;
  maxTradesPerScan: number;
  maxTradesPerDay: number;
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

export interface OperatorPositionSnapshot {
  marketId: string;
  outcome: 'YES' | 'NO';
  exposureUsd: number;
  unrealizedPnlUsd: number | null;
}

export interface OperatorTradeSnapshot {
  marketId: string;
  outcome: string;
  pnlUsd: number | null;
  timestamp: string;
}

export interface OperatorStatusSnapshot {
  asOf: string;
  equityUsd: number | null;
  openPositions: OperatorPositionSnapshot[];
  policyState: {
    observationOnly: boolean;
    reason: string | null;
    minEdgeOverride: number | null;
    maxTradesPerScanOverride: number | null;
    leverageCapOverride: number | null;
  };
  lastTrade: OperatorTradeSnapshot | null;
  nextScanAt: string | null;
  uptimeMs: number;
  runtime: {
    enabled: boolean;
    fullAuto: boolean;
    isPaused: boolean;
    pauseReason: string;
    consecutiveLosses: number;
    remainingDaily: number;
  };
  dailyPnl: DailyPnL & { totalPnl: number };
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
  private readonly schedulerNamespace: string;
  private readonly startedAtMs: number;

  private isPaused = false;
  private pauseReason = '';
  private consecutiveLosses = 0;
  private scheduler: SchedulerControlPlane | null = null;

  constructor(
    _llm: LlmClient,
    marketClient: MarketClient,
    executor: ExecutionAdapter,
    limiter: DbSpendingLimitEnforcer,
    thufirConfig: ThufirConfig,
    logger?: Logger
  ) {
    super();
    this.marketClient = marketClient;
    this.executor = executor;
    this.limiter = limiter;
    this.thufirConfig = thufirConfig;
    this.logger = logger ?? new Logger('info');
    this.schedulerNamespace = this.buildSchedulerNamespace();
    this.startedAtMs = Date.now();

    // Load autonomous config with defaults
    this.config = {
      enabled: thufirConfig.autonomy?.enabled ?? false,
      fullAuto: (thufirConfig.autonomy as any)?.fullAuto ?? false,
      minEdge: (thufirConfig.autonomy as any)?.minEdge ?? 0.05,
      requireHighConfidence: (thufirConfig.autonomy as any)?.requireHighConfidence ?? false,
      pauseOnLossStreak: (thufirConfig.autonomy as any)?.pauseOnLossStreak ?? 3,
      dailyReportTime: (thufirConfig.autonomy as any)?.dailyReportTime ?? '20:00',
      maxTradesPerScan: (thufirConfig.autonomy as any)?.maxTradesPerScan ?? 3,
      maxTradesPerDay: (thufirConfig.autonomy as any)?.maxTradesPerDay ?? 25,
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
    if (this.scheduler) {
      return;
    }

    const scanInterval = this.thufirConfig.autonomy?.scanIntervalSeconds ?? 900;
    const scheduler = new SchedulerControlPlane({
      ownerId: `autonomous:${process.pid}`,
      pollIntervalMs: 1_000,
      defaultLeaseMs: Math.max(30_000, scanInterval * 2_000),
    });

    scheduler.registerJob(
      {
        name: `${this.schedulerNamespace}:scan`,
        schedule: { kind: 'interval', intervalMs: scanInterval * 1_000 },
        leaseMs: Math.max(30_000, scanInterval * 2_000),
      },
      async () => {
        try {
          await this.runScan();
        } catch (error) {
          this.logger.error('Autonomous scan failed', error);
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      }
    );

    scheduler.registerJob(
      {
        name: `${this.schedulerNamespace}:report`,
        schedule: { kind: 'daily', time: this.config.dailyReportTime },
        leaseMs: 60_000,
      },
      async () => {
        await this.runDailyReportTick();
      }
    );

    scheduler.start();
    this.scheduler = scheduler;

    this.logger.info(`Autonomous mode started. Full auto: ${this.config.fullAuto}. Scan interval: ${scanInterval}s`);
  }

  /**
   * Stop autonomous mode
   */
  stop(): void {
    this.scheduler?.stop();
    this.scheduler = null;
    this.logger.info('Autonomous mode stopped');
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
  async runScan(options?: { forceExecute?: boolean; maxTrades?: number }): Promise<string> {
    if (this.isPaused) {
      return `Autonomous trading is paused: ${this.pauseReason}`;
    }

    const remaining = this.limiter.getRemainingDaily();
    if (remaining <= 0) {
      return 'Daily spending limit reached. No trades executed.';
    }

    const forceExecute = Boolean(options?.forceExecute);
    const executeTrades = forceExecute || this.config.fullAuto;
    const maxTrades = options?.maxTrades;
    return this.runDiscoveryScan({ executeTrades, maxTrades, ignoreThresholds: forceExecute });
  }

  private async runDiscoveryScan(input: {
    executeTrades: boolean;
    maxTrades?: number;
    ignoreThresholds?: boolean;
  }): Promise<string> {
    const recentJournal = listPerpTradeJournals({ limit: 50 });
    const reflectionMutation = applyReflectionMutation(this.thufirConfig, recentJournal);
    const policyState = getAutonomyPolicyState();
    const observationActive =
      policyState.observationOnlyUntilMs != null && policyState.observationOnlyUntilMs > Date.now();

    const result = await runDiscovery(this.thufirConfig);
    if (result.expressions.length === 0) {
      return 'No discovery expressions generated.';
    }
    const clusterBySymbol = new Map(result.clusters.map((cluster) => [cluster.symbol, cluster]));

    if (!input.executeTrades || observationActive) {
      const top = result.expressions.slice(0, 5);
      if (observationActive) {
        for (const expr of top) {
          const symbol = expr.symbol.includes('/') ? expr.symbol.split('/')[0]! : expr.symbol;
          const cluster = clusterBySymbol.get(expr.symbol);
          const regime = cluster ? classifyMarketRegime(cluster) : 'choppy';
          const signalClass = classifySignalClass(expr);
          const volatilityBucket = cluster ? resolveVolatilityBucket(cluster) : 'medium';
          const liquidityBucket = cluster ? resolveLiquidityBucket(cluster) : 'normal';
          const contextTrace = formatContextPackTrace({
            marketRegime: expr.contextPack?.regime.marketRegime ?? regime,
            volatilityBucket: expr.contextPack?.regime.volatilityBucket ?? volatilityBucket,
            liquidityBucket: expr.contextPack?.regime.liquidityBucket ?? liquidityBucket,
            executionStatus: expr.contextPack?.executionQuality.status ?? 'unknown',
            eventKind: expr.contextPack?.event.kind ?? (expr.newsTrigger?.enabled ? 'news_event' : 'technical'),
            portfolioPosture: expr.contextPack?.portfolioState.posture ?? 'unknown',
            missing: expr.contextPack?.missing ?? ['contextPack.provider'],
          });
          try {
            recordPerpTradeJournal({
              kind: 'perp_trade_journal',
              tradeId: null,
              hypothesisId: expr.hypothesisId ?? null,
              symbol,
              side: expr.side,
              size: null,
              leverage: expr.leverage ?? null,
              orderType: expr.orderType ?? null,
              reduceOnly: false,
              markPrice: null,
              confidence: expr.confidence != null ? String(expr.confidence) : null,
              reasoning: `Observation-only mode: would execute ${expr.side} ${symbol} (edge=${(expr.expectedEdge * 100).toFixed(2)}%) ${contextTrace}`,
              signalClass,
              marketRegime: regime,
              volatilityBucket,
              liquidityBucket,
              expectedEdge: expr.expectedEdge,
              thesisCorrect: null,
              entryTrigger: expr.newsTrigger?.enabled ? 'news' : 'technical',
              newsSubtype: expr.newsTrigger?.subtype ?? null,
              newsSources: Array.isArray(expr.newsTrigger?.sources)
                ? expr.newsTrigger?.sources
                    .map((source) => String(source.ref ?? source.source ?? '').trim())
                    .filter((source) => source.length > 0)
                : null,
              newsSourceCount: Array.isArray(expr.newsTrigger?.sources) ? expr.newsTrigger.sources.length : null,
              noveltyScore: expr.newsTrigger?.noveltyScore ?? null,
              marketConfirmationScore: expr.newsTrigger?.marketConfirmationScore ?? null,
              thesisExpiresAtMs: expr.newsTrigger?.expiresAtMs ?? null,
              outcome: 'blocked',
              message: 'Observation-only mode active; live execution suppressed.',
            });
          } catch {
            // Best-effort journaling.
          }
        }
      }
      const lines = top.map(
        (expr) => {
          const contextTrace = formatContextPackTrace({
            marketRegime: expr.contextPack?.regime.marketRegime ?? expr.marketRegime ?? 'choppy',
            volatilityBucket: expr.contextPack?.regime.volatilityBucket ?? expr.volatilityBucket ?? 'medium',
            liquidityBucket: expr.contextPack?.regime.liquidityBucket ?? expr.liquidityBucket ?? 'normal',
            executionStatus: expr.contextPack?.executionQuality.status ?? 'unknown',
            eventKind: expr.contextPack?.event.kind ?? (expr.newsTrigger?.enabled ? 'news_event' : 'technical'),
            portfolioPosture: expr.contextPack?.portfolioState.posture ?? 'unknown',
            missing: expr.contextPack?.missing ?? ['contextPack.provider'],
          });
          return `- ${expr.symbol} ${expr.side} probe=${expr.probeSizeUsd.toFixed(2)} leverage=${expr.leverage} (${expr.expectedMove}) ${contextTrace}`;
        }
      );
      const header = observationActive
        ? `Discovery scan completed in observation-only mode (${policyState.reason ?? 'adaptive policy active'}).`
        : 'Discovery scan completed:';
      return `${header}\n${lines.join('\n')}`;
    }

    const baseMinEdge = this.config.minEdge;
    const adaptiveMinEdge = policyState.minEdgeOverride ?? baseMinEdge;
    const adaptiveMaxTrades = policyState.maxTradesPerScanOverride ?? this.config.maxTradesPerScan;
    const adaptiveLeverageCap =
      policyState.leverageCapOverride ?? Number((this.thufirConfig.hyperliquid as any)?.maxLeverage ?? 5);

    const eligible = result.expressions.filter((expr) => {
      const cluster = clusterBySymbol.get(expr.symbol);
      const regime = cluster ? classifyMarketRegime(cluster) : 'choppy';
      const signalClass = classifySignalClass(expr);
      const globalGate = evaluateGlobalTradeGate(this.thufirConfig, {
        signalClass,
        marketRegime: regime,
        expectedEdge: expr.expectedEdge,
      });
      if (!globalGate.allowed) {
        return false;
      }
      if (!isSignalClassAllowedForRegime(signalClass, regime)) {
        return false;
      }
      const newsGate = evaluateNewsEntryGate(this.thufirConfig, expr);
      if (!newsGate.allowed) {
        return false;
      }
      if (input.ignoreThresholds) {
        return true;
      }
      if (expr.expectedEdge < adaptiveMinEdge) {
        return false;
      }
      const { sessionWeight } = resolveSessionWeightContext(new Date());
      const weightedConfidence = clamp01(expr.confidence * sessionWeight);
      if (this.config.requireHighConfidence && weightedConfidence < 0.7) {
        return false;
      }
      return true;
    });
    if (eligible.length === 0) {
      return 'No expressions met autonomy thresholds (minEdge/confidence).';
    }

    // If we're forcing execution, pick the "best" expression first (highest expected edge).
    const ranked = input.ignoreThresholds
      ? [...eligible].sort((a, b) => (b.expectedEdge ?? 0) - (a.expectedEdge ?? 0))
      : eligible;

    const maxTrades = Number.isFinite(input.maxTrades)
      ? Math.min(Math.max(Number(input.maxTrades), 1), 10)
      : adaptiveMaxTrades;
    const toExecute = ranked.slice(0, maxTrades);
    const outputs: string[] = [];

    for (const expr of toExecute) {
      const symbol = expr.symbol.includes('/') ? expr.symbol.split('/')[0]! : expr.symbol;
      const sessionContext = resolveSessionWeightContext(new Date());
      const confidenceRaw = clamp01(expr.confidence ?? 0);
      const confidenceWeighted = clamp01(confidenceRaw * sessionContext.sessionWeight);
      const sizingModifier = sessionContext.sessionWeight;
      const market = await this.marketClient.getMarket(symbol);
      const cluster = clusterBySymbol.get(expr.symbol);
      const regime = cluster ? classifyMarketRegime(cluster) : 'choppy';
      const signalClass = classifySignalClass(expr);
      const volatilityBucket = cluster ? resolveVolatilityBucket(cluster) : 'medium';
      const liquidityBucket = cluster ? resolveLiquidityBucket(cluster) : 'normal';
      const globalGate = evaluateGlobalTradeGate(this.thufirConfig, {
        signalClass,
        marketRegime: regime,
        expectedEdge: expr.expectedEdge,
      });
      if (!globalGate.allowed) {
        outputs.push(`${symbol}: Blocked (${globalGate.reason ?? 'policy gate'})`);
        continue;
      }
      const newsGate = evaluateNewsEntryGate(this.thufirConfig, expr);
      if (!newsGate.allowed) {
        outputs.push(`${symbol}: Blocked (${newsGate.reason ?? 'news gate'})`);
        continue;
      }
      const markPrice = market.markPrice ?? 0;
      const minOrderUsd =
        typeof (this.thufirConfig as any)?.hyperliquid?.minOrderNotionalUsd === 'number'
          ? Number((this.thufirConfig as any).hyperliquid.minOrderNotionalUsd)
          : 10;
      const remainingDaily = this.limiter.getRemainingDaily();
      const desiredUsd = Number.isFinite(expr.probeSizeUsd) ? expr.probeSizeUsd : 0;
      const perf = summarizeSignalPerformance(listPerpTradeJournals({ limit: 200 }), signalClass);
      const kellyFraction = computeFractionalKellyFraction({
        expectedEdge: expr.expectedEdge,
        signalExpectancy: Math.max(0.01, perf.expectancy + 0.5),
        signalVariance: Math.max(0.1, perf.variance),
        sampleCount: perf.sampleCount,
        maxFraction: Number((this.thufirConfig.autonomy as any)?.newsEntry?.maxKellyFraction ?? 0.25),
      });
      const signalAdjustedUsd = desiredUsd * Math.max(0.25, kellyFraction * 4) * sizingModifier;
      const newsSizeCapFraction = Number((this.thufirConfig.autonomy as any)?.newsEntry?.sizeCapFraction ?? 0.5);
      const cappedForNews =
        expr.newsTrigger?.enabled === true
          ? Math.min(signalAdjustedUsd, remainingDaily * clamp01(newsSizeCapFraction))
          : signalAdjustedUsd;
      const probeUsd = Math.min(Math.max(minOrderUsd, cappedForNews), remainingDaily);
      this.logger.info('Session weighting applied to autonomous decision inputs', {
        symbol,
        session: sessionContext.session,
        sessionWeight: Number(sessionContext.sessionWeight.toFixed(4)),
        confidenceBefore: Number(confidenceRaw.toFixed(4)),
        confidenceAfter: Number(confidenceWeighted.toFixed(4)),
        sizingModifier: Number(sizingModifier.toFixed(4)),
        sizeUsdBefore: Number(desiredUsd.toFixed(4)),
        sizeUsdAfter: Number(signalAdjustedUsd.toFixed(4)),
      });
      if (probeUsd <= 0) {
        outputs.push(`${symbol}: Skipped (insufficient daily budget)`);
        continue;
      }
      if (probeUsd < minOrderUsd) {
        outputs.push(`${symbol}: Skipped (remaining daily budget $${remainingDaily.toFixed(2)} below min order $${minOrderUsd.toFixed(2)})`);
        continue;
      }
      const size = markPrice > 0 ? probeUsd / markPrice : probeUsd;
      const targetLeverage = Math.min(expr.leverage, adaptiveLeverageCap);

      const riskCheck = await checkPerpRiskLimits({
        config: this.thufirConfig,
        symbol,
        side: expr.side,
        size,
        leverage: targetLeverage,
        reduceOnly: false,
        markPrice: markPrice || null,
        notionalUsd: Number.isFinite(probeUsd) ? probeUsd : undefined,
        marketMaxLeverage:
          typeof market.metadata?.maxLeverage === 'number'
            ? (market.metadata.maxLeverage as number)
            : null,
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
        leverage: targetLeverage,
        reasoning: `${expr.expectedMove} | edge=${(expr.expectedEdge * 100).toFixed(2)}% confidence=${(
          confidenceWeighted * 100
        ).toFixed(1)}% regime=${regime} signal=${signalClass} kelly=${(kellyFraction * 100).toFixed(
          1
        )}% session=${sessionContext.session} sessionWeight=${sessionContext.sessionWeight.toFixed(
          2
        )} confidenceRaw=${confidenceRaw.toFixed(3)} confidenceWeighted=${confidenceWeighted.toFixed(
          3
        )} sizingModifier=${sizingModifier.toFixed(2)} ${formatContextPackTrace({
          marketRegime: expr.contextPack?.regime.marketRegime ?? regime,
          volatilityBucket: expr.contextPack?.regime.volatilityBucket ?? volatilityBucket,
          liquidityBucket: expr.contextPack?.regime.liquidityBucket ?? liquidityBucket,
          executionStatus: expr.contextPack?.executionQuality.status ?? 'unknown',
          eventKind: expr.contextPack?.event.kind ?? (expr.newsTrigger?.enabled ? 'news_event' : 'technical'),
          portfolioPosture: expr.contextPack?.portfolioState.posture ?? 'unknown',
          missing: expr.contextPack?.missing ?? ['contextPack.provider'],
        })}`,
      };

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
          leverage: expr.leverage,
          orderType: expr.orderType,
          status: tradeResult.executed ? 'executed' : 'failed',
        });
        const db = openDatabase();
        db.prepare(`
          INSERT INTO autonomous_trades (
            id,
            market_id,
            market_title,
            direction,
            amount,
            entry_price,
            confidence,
            reasoning,
            timestamp,
            outcome,
            pnl
          ) VALUES (
            @id,
            @marketId,
            @marketTitle,
            @direction,
            @amount,
            @entryPrice,
            @confidence,
            @reasoning,
            @timestamp,
            @outcome,
            @pnl
          )
        `).run({
          id: String(tradeId),
          marketId: symbol,
          marketTitle: `${symbol} perp`,
          direction: expr.side,
          amount: probeUsd,
          entryPrice: markPrice || 0,
          confidence: expr.confidence != null ? String(expr.confidence) : null,
          reasoning: decision.reasoning ?? null,
          timestamp: new Date().toISOString(),
          outcome: tradeResult.executed ? 'pending' : 'failed',
          pnl: null,
        });
        recordPerpTradeJournal({
          kind: 'perp_trade_journal',
          tradeId,
          hypothesisId: expr.hypothesisId ?? null,
          symbol,
          side: expr.side,
          size,
          leverage: targetLeverage ?? null,
          orderType: expr.orderType ?? null,
          reduceOnly: false,
          markPrice: markPrice || null,
          confidence: String(confidenceWeighted),
          reasoning: decision.reasoning ?? null,
          signalClass,
          marketRegime: regime,
          volatilityBucket,
          liquidityBucket,
          expectedEdge: expr.expectedEdge,
          thesisCorrect: tradeResult.executed ? null : false,
          entryTrigger: expr.newsTrigger?.enabled ? 'news' : 'technical',
          newsSubtype: expr.newsTrigger?.subtype ?? null,
          newsSources: Array.isArray(expr.newsTrigger?.sources)
            ? expr.newsTrigger?.sources
                .map((source) => String(source.ref ?? source.source ?? '').trim())
                .filter((source) => source.length > 0)
            : null,
          newsSourceCount: Array.isArray(expr.newsTrigger?.sources) ? expr.newsTrigger.sources.length : null,
          noveltyScore: expr.newsTrigger?.noveltyScore ?? null,
          marketConfirmationScore: expr.newsTrigger?.marketConfirmationScore ?? null,
          thesisExpiresAtMs: expr.newsTrigger?.expiresAtMs ?? null,
          outcome: tradeResult.executed ? 'executed' : 'failed',
          message: tradeResult.message,
        });
      } catch {
        // Best-effort journaling: never block trading due to local DB issues.
      }
      outputs.push(tradeResult.message);
    }

    if (reflectionMutation.mutated) {
      outputs.push(`Adaptive policy updated: ${reflectionMutation.reason ?? 'performance mutation applied'}`);
    }

    return outputs.join('\n');
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

  getOperatorSnapshot(): OperatorStatusSnapshot {
    const dailyPnl = this.getDailyPnL();
    const runtime = this.getStatus();
    const policyState = getAutonomyPolicyState();
    const observationOnly =
      policyState.observationOnlyUntilMs != null && policyState.observationOnlyUntilMs > Date.now();
    const openPositions = listOpenPositionsFromTrades(20).map((position) => ({
      marketId: position.marketId,
      outcome: position.predictedOutcome ?? 'YES',
      exposureUsd: Number(position.positionSize ?? 0),
      unrealizedPnlUsd: this.computePositionUnrealizedPnl(position),
    }));
    const totalPnl = dailyPnl.realizedPnl + dailyPnl.unrealizedPnl;

    return {
      asOf: new Date().toISOString(),
      equityUsd: null,
      openPositions,
      policyState: {
        observationOnly,
        reason: policyState.reason,
        minEdgeOverride: policyState.minEdgeOverride,
        maxTradesPerScanOverride: policyState.maxTradesPerScanOverride,
        leverageCapOverride: policyState.leverageCapOverride,
      },
      lastTrade: this.getLastTradeSnapshot(),
      nextScanAt: this.getNextScanAt(),
      uptimeMs: Math.max(0, Date.now() - this.startedAtMs),
      runtime,
      dailyPnl: {
        ...dailyPnl,
        totalPnl,
      },
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

  async runDailyReportTick(): Promise<void> {
    try {
      const report = await this.generateDailyPnLReport();
      this.emit('daily-report', report);
    } catch (error) {
      this.logger.error('Failed to generate daily report', error);
      throw error;
    }
  }

  private calculateUnrealizedPnl(): number {
    const positions = listOpenPositionsFromTrades(200);
    let total = 0;

    for (const position of positions) {
      const pnl = this.computePositionUnrealizedPnl(position);
      if (pnl == null) continue;
      total += pnl;
    }

    return total;
  }

  private computePositionUnrealizedPnl(position: OpenTradePosition): number | null {
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
      return null;
    }
    const shares = positionSize / averagePrice;
    const price = currentPrice ?? averagePrice;
    const value = shares * price;
    return value - positionSize;
  }

  private getLastTradeSnapshot(): OperatorTradeSnapshot | null {
    try {
      const db = openDatabase();
      const row = db
        .prepare(
          `
          SELECT
            market_id as marketId,
            outcome,
            pnl as pnlUsd,
            timestamp
          FROM autonomous_trades
          ORDER BY datetime(timestamp) DESC
          LIMIT 1
        `
        )
        .get() as
        | { marketId?: string; outcome?: string; pnlUsd?: number | null; timestamp?: string }
        | undefined;
      if (!row?.marketId || !row?.timestamp) {
        return null;
      }
      return {
        marketId: String(row.marketId),
        outcome: String(row.outcome ?? 'unknown'),
        pnlUsd: typeof row.pnlUsd === 'number' ? row.pnlUsd : null,
        timestamp: String(row.timestamp),
      };
    } catch {
      return null;
    }
  }

  private getNextScanAt(): string | null {
    try {
      const db = openDatabase();
      const row = db
        .prepare(
          `
          SELECT next_run_at as nextRunAt
          FROM scheduler_jobs
          WHERE name = @name
          LIMIT 1
        `
        )
        .get({ name: `${this.schedulerNamespace}:scan` }) as { nextRunAt?: string } | undefined;
      if (!row?.nextRunAt) {
        return null;
      }
      return String(row.nextRunAt);
    } catch {
      return null;
    }
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

  private buildSchedulerNamespace(): string {
    const seed =
      this.thufirConfig.memory?.sessionsPath ??
      this.thufirConfig.memory?.dbPath ??
      this.thufirConfig.agent?.workspace ??
      'default';
    const hash = Buffer.from(seed).toString('base64url').slice(0, 16);
    return `autonomy:${hash}`;
  }
}
