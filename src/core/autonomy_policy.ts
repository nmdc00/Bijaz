import type { ExpressionPlan, SignalCluster } from '../discovery/types.js';
import type { ThufirConfig } from './config.js';
import type { PerpTradeJournalEntry } from '../memory/perp_trade_journal.js';
import { listPerpTradeJournals } from '../memory/perp_trade_journal.js';
import { openDatabase } from '../memory/db.js';
import { getAutonomyPolicyState, upsertAutonomyPolicyState } from '../memory/autonomy_policy_state.js';
import { summarizeSignalPerformance } from './signal_performance.js';

export type MarketRegime = 'trending' | 'choppy' | 'high_vol_expansion' | 'low_vol_compression';
export type SignalClass =
  | 'momentum_breakout'
  | 'mean_reversion'
  | 'news_event'
  | 'liquidation_cascade'
  | 'unknown';

export type NewsGateResult = { allowed: boolean; reason?: string };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function classifyMarketRegime(cluster: SignalCluster): MarketRegime {
  const pv = cluster.signals.find((signal) => signal.kind === 'price_vol_regime');
  const trend = typeof pv?.metrics?.trend === 'number' ? pv.metrics.trend : 0;
  const volZ = typeof pv?.metrics?.volZ === 'number' ? pv.metrics.volZ : 0;

  if (volZ >= 1.0) return 'high_vol_expansion';
  if (volZ <= -0.5) return 'low_vol_compression';
  if (Math.abs(trend) >= 0.015) return 'trending';
  return 'choppy';
}

export function classifySignalClass(expression: ExpressionPlan): SignalClass {
  if (expression.signalClass) return expression.signalClass as SignalClass;
  if (expression.newsTrigger?.enabled) return 'news_event';
  if (expression.hypothesisId.includes('_revert')) return 'mean_reversion';
  if (expression.hypothesisId.includes('_reflex')) return 'liquidation_cascade';
  if (expression.hypothesisId.includes('_trend')) return 'momentum_breakout';
  return 'unknown';
}

export function resolveVolatilityBucket(cluster: SignalCluster): 'low' | 'medium' | 'high' {
  const pv = cluster.signals.find((signal) => signal.kind === 'price_vol_regime');
  const volZ = typeof pv?.metrics?.volZ === 'number' ? Math.abs(pv.metrics.volZ) : 0;
  if (volZ >= 1.2) return 'high';
  if (volZ <= 0.4) return 'low';
  return 'medium';
}

export function resolveLiquidityBucket(cluster: SignalCluster): 'thin' | 'normal' | 'deep' {
  const orderflow = cluster.signals.find((signal) => signal.kind === 'orderflow_imbalance');
  const count = typeof orderflow?.metrics?.tradeCount === 'number' ? orderflow.metrics.tradeCount : 0;
  if (count >= 18) return 'deep';
  if (count <= 4) return 'thin';
  return 'normal';
}

export function isSignalClassAllowedForRegime(
  signalClass: SignalClass,
  regime: MarketRegime
): boolean {
  const matrix: Record<MarketRegime, Set<SignalClass>> = {
    trending: new Set(['momentum_breakout', 'news_event', 'liquidation_cascade']),
    choppy: new Set(['mean_reversion', 'news_event']),
    high_vol_expansion: new Set(['liquidation_cascade', 'news_event', 'momentum_breakout']),
    low_vol_compression: new Set(['mean_reversion', 'news_event']),
  };
  return matrix[regime].has(signalClass);
}

export function evaluateNewsEntryGate(
  config: ThufirConfig,
  expression: ExpressionPlan,
  nowMs = Date.now()
): NewsGateResult {
  const trigger = expression.newsTrigger;
  if (!trigger?.enabled) {
    return { allowed: true };
  }

  const gate = (config.autonomy as any)?.newsEntry ?? {};
  const minNovelty = Number.isFinite(gate.minNoveltyScore) ? Number(gate.minNoveltyScore) : 0.6;
  const minConfirm = Number.isFinite(gate.minMarketConfirmationScore)
    ? Number(gate.minMarketConfirmationScore)
    : 0.55;
  const minLiquidity = Number.isFinite(gate.minLiquidityScore) ? Number(gate.minLiquidityScore) : 0.4;
  const minVolatility = Number.isFinite(gate.minVolatilityScore) ? Number(gate.minVolatilityScore) : 0.25;
  const minSourceCount = Number.isFinite(gate.minSourceCount) ? Number(gate.minSourceCount) : 1;
  const sourceCount = Array.isArray(trigger.sources) ? trigger.sources.filter(Boolean).length : 0;

  if (trigger.expiresAtMs != null && trigger.expiresAtMs <= nowMs) {
    return { allowed: false, reason: 'news trigger expired' };
  }
  if ((trigger.noveltyScore ?? 0) < minNovelty) {
    return { allowed: false, reason: 'news novelty below threshold' };
  }
  if ((trigger.marketConfirmationScore ?? 0) < minConfirm) {
    return { allowed: false, reason: 'news market confirmation below threshold' };
  }
  if ((trigger.liquidityScore ?? 0) < minLiquidity) {
    return { allowed: false, reason: 'news liquidity guard failed' };
  }
  if ((trigger.volatilityScore ?? 0) < minVolatility) {
    return { allowed: false, reason: 'news volatility guard failed' };
  }
  if (sourceCount < Math.max(0, minSourceCount)) {
    return { allowed: false, reason: 'news source provenance below threshold' };
  }

  return { allowed: true };
}

export function computeFractionalKellyFraction(params: {
  expectedEdge: number;
  signalExpectancy: number;
  signalVariance: number;
  sampleCount: number;
  maxFraction?: number;
}): number {
  const maxFraction = Number.isFinite(params.maxFraction) ? Number(params.maxFraction) : 0.25;
  const edge = Math.max(0, params.expectedEdge * Math.max(0, params.signalExpectancy));
  const variance = Math.max(params.signalVariance, 0.1);
  const rawKelly = edge / variance;
  const sampleConfidence = clamp(params.sampleCount / 20, 0.2, 1);
  const fractional = rawKelly * 0.25 * sampleConfidence;
  return clamp(fractional, 0.01, maxFraction);
}

export function countTodayExecutedPerpTrades(): number {
  const db = openDatabase();
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS c
      FROM perp_trades
      WHERE status = 'executed'
        AND date(created_at) = date('now')
    `
    )
    .get() as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

export function shouldForceObservationMode(
  entries: PerpTradeJournalEntry[],
  params?: { window?: number; minFalse?: number }
): { active: boolean; falseCount: number; window: number } {
  const window = Math.max(1, params?.window ?? 5);
  const minFalse = Math.max(1, params?.minFalse ?? 3);
  const recent = entries
    .filter((entry) => typeof entry.thesisCorrect === 'boolean')
    .slice(0, window);
  const falseCount = recent.filter((entry) => entry.thesisCorrect === false).length;
  return { active: recent.length >= window && falseCount >= minFalse, falseCount, window };
}

export function evaluateGlobalTradeGate(config: ThufirConfig, input?: {
  signalClass?: string | null;
  marketRegime?: MarketRegime | null;
}): { allowed: boolean; reason?: string; policyState: ReturnType<typeof getAutonomyPolicyState> } {
  const autonomyEnabled = Boolean((config.autonomy as any)?.enabled);
  const fullAutoEnabled = Boolean((config.autonomy as any)?.fullAuto);
  if (!autonomyEnabled && !fullAutoEnabled) {
    return {
      allowed: true,
      policyState: {
        minEdgeOverride: null,
        maxTradesPerScanOverride: null,
        leverageCapOverride: null,
        observationOnlyUntilMs: null,
        reason: null,
        updatedAt: new Date(0).toISOString(),
      },
    };
  }

  const policyState = getAutonomyPolicyState();
  const nowMs = Date.now();
  if (policyState.observationOnlyUntilMs != null && policyState.observationOnlyUntilMs > nowMs) {
    return {
      allowed: false,
      reason: `observation-only mode active until ${new Date(policyState.observationOnlyUntilMs).toISOString()}`,
      policyState,
    };
  }

  const maxTradesPerDay =
    Number((config.autonomy as any)?.maxTradesPerDay ?? 25) > 0
      ? Number((config.autonomy as any)?.maxTradesPerDay)
      : 25;
  const todayCount = countTodayExecutedPerpTrades();
  if (todayCount >= maxTradesPerDay) {
    return {
      allowed: false,
      reason: `maxTradesPerDay reached (${todayCount}/${maxTradesPerDay})`,
      policyState,
    };
  }

  if (input?.signalClass) {
    const perf = summarizeSignalPerformance(listPerpTradeJournals({ limit: 200 }), input.signalClass);
    const minSharpe = Number((config.autonomy as any)?.signalPerformance?.minSharpe ?? 0.8);
    const minSamples = Number((config.autonomy as any)?.signalPerformance?.minSamples ?? 8);
    if (perf.sampleCount >= minSamples && perf.sharpeLike < minSharpe) {
      return {
        allowed: false,
        reason: `signal_class ${input.signalClass} sharpeLike ${perf.sharpeLike.toFixed(2)} below ${minSharpe.toFixed(2)}`,
        policyState,
      };
    }

    if (input.marketRegime && !isSignalClassAllowedForRegime(input.signalClass as SignalClass, input.marketRegime)) {
      return {
        allowed: false,
        reason: `signal_class ${input.signalClass} disallowed in regime ${input.marketRegime}`,
        policyState,
      };
    }
  }

  return { allowed: true, policyState };
}

export function applyReflectionMutation(config: ThufirConfig, entries: PerpTradeJournalEntry[]): {
  mutated: boolean;
  reason?: string;
  state: ReturnType<typeof getAutonomyPolicyState>;
} {
  const observation = shouldForceObservationMode(entries, { window: 5, minFalse: 3 });
  if (observation.active) {
    const intervalSeconds = Number(config.autonomy?.scanIntervalSeconds ?? 900);
    const ttlMs = Math.max(60_000, intervalSeconds * 1000);
    const state = upsertAutonomyPolicyState({
      observationOnlyUntilMs: Date.now() + ttlMs,
      reason: `thesisCorrect=false on ${observation.falseCount}/${observation.window}`,
    });
    return { mutated: true, reason: state.reason ?? undefined, state };
  }

  const recent = entries.slice(0, 10);
  const failedRatio =
    recent.length > 0 ? recent.filter((entry) => entry.outcome === 'failed').length / recent.length : 0;
  if (recent.length >= 6 && failedRatio >= 0.5) {
    const current = getAutonomyPolicyState();
    const state = upsertAutonomyPolicyState({
      minEdgeOverride: clamp((current.minEdgeOverride ?? Number(config.autonomy?.minEdge ?? 0.05)) + 0.01, 0.03, 0.2),
      maxTradesPerScanOverride: Math.max(1, (current.maxTradesPerScanOverride ?? Number(config.autonomy?.maxTradesPerScan ?? 3)) - 1),
      leverageCapOverride: Math.max(1, (current.leverageCapOverride ?? Number((config.hyperliquid as any)?.maxLeverage ?? 5)) - 1),
      reason: `recent failed ratio ${(failedRatio * 100).toFixed(0)}% triggered adaptive tightening`,
    });
    return { mutated: true, reason: state.reason ?? undefined, state };
  }

  return { mutated: false, state: getAutonomyPolicyState() };
}
