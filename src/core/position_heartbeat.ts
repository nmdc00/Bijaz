import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';

import type { ThufirConfig } from './config.js';
import { createExecutorClient, type ChatMessage, type LlmClient } from './llm.js';
import { Logger } from './logger.js';
import type { ToolExecutorContext } from './tool-executor.js';
import { executeToolCall } from './tool-executor.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import { recordPositionHeartbeatDecision } from '../memory/position_heartbeat_journal.js';
import { retryWithBackoff } from './retry.js';
import {
  defaultTriggerState,
  evaluateHeartbeatTriggers,
  type HeartbeatTriggerConfig,
  type HeartbeatTriggerFired,
  type HeartbeatTriggerName,
  type PositionTick,
  type PositionSide,
  type TriggerState,
} from './heartbeat_triggers.js';

type HeartbeatAction =
  | { action: 'hold'; reason: string }
  | { action: 'tighten_stop'; params: { newStopPrice: number }; reason: string }
  | { action: 'adjust_take_profit'; params: { newTakeProfitPrice: number }; reason: string }
  | { action: 'take_partial_profit'; params: { fraction?: number; size?: number }; reason: string }
  | { action: 'close_entirely'; reason: string };

type HeartbeatPosition = {
  symbol: string;
  positionSide: PositionSide;
  positionSize: number;
  entryPrice: number;
  liquidationPrice: number;
  unrealizedPnl: number;
};

type ParsedOrders = {
  stopLossPrice: number | null;
  stopLossOid: string | null;
  takeProfitPrice: number | null;
  takeProfitOid: string | null;
};

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function sign(n: number): number {
  if (!Number.isFinite(n) || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

function pctDist(a: number, b: number): number {
  if (!Number.isFinite(a) || a === 0 || !Number.isFinite(b)) return Infinity;
  return (Math.abs(a - b) / Math.abs(a)) * 100;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableHyperliquidPollError(err: unknown): boolean {
  const e = err as any;
  const msg = String(e?.message ?? '');
  const name = String(e?.name ?? '');
  const causeName = String(e?.cause?.name ?? '');
  // If we got an HTTP response, treat it as non-retryable (bad request/auth/etc).
  if (e?.response != null) return false;
  // Transport-level errors are usually transient.
  if (/timeout/i.test(msg) || /aborted/i.test(msg)) return true;
  if (/TimeoutError/i.test(name) || /TimeoutError/i.test(causeName)) return true;
  if (/HttpRequestError/i.test(name)) return true;
  // Default to retrying for unknown network-ish failures.
  return true;
}

function extractFirstJsonObject(text: string): unknown | null {
  const fenced = /```json\s*([\s\S]*?)\s*```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function summarizeTriggers(triggers: HeartbeatTriggerFired[]): string {
  return triggers.map((t) => `- ${t.name}: ${t.detail}`).join('\n');
}

function formatTrajectory(buffer: PositionTick[], maxRows = 20): string {
  const rows = buffer.slice(-maxRows);
  const lines = rows.map((t) => {
    const ts = new Date(t.timestamp).toISOString();
    return `${ts} px=${t.markPrice.toFixed(2)} pnl=${t.unrealizedPnl.toFixed(2)} (${t.pnlPctOfEquity.toFixed(2)}% eq)`;
  });
  return lines.join('\n');
}

function validateAction(params: {
  action: HeartbeatAction;
  tick: PositionTick;
  stopLossPrice: number | null;
}): { ok: true } | { ok: false; error: string } {
  const { action, tick, stopLossPrice } = params;

  if (action.action === 'hold' || action.action === 'close_entirely') return { ok: true };

  if (action.action === 'take_partial_profit') {
    const frac = action.params.fraction;
    const sz = action.params.size;
    if (frac == null && sz == null) return { ok: false, error: 'Missing fraction or size.' };
    if (frac != null && (!Number.isFinite(frac) || frac <= 0 || frac >= 1)) {
      return { ok: false, error: 'fraction must be between 0 and 1 (exclusive).' };
    }
    if (sz != null && (!Number.isFinite(sz) || sz <= 0)) {
      return { ok: false, error: 'size must be a positive number.' };
    }
    return { ok: true };
  }

  if (action.action === 'adjust_take_profit') {
    const px = action.params.newTakeProfitPrice;
    if (!Number.isFinite(px) || px <= 0) return { ok: false, error: 'newTakeProfitPrice must be > 0.' };
    return { ok: true };
  }

  if (action.action === 'tighten_stop') {
    const px = action.params.newStopPrice;
    if (!Number.isFinite(px) || px <= 0) return { ok: false, error: 'newStopPrice must be > 0.' };

    // Must not loosen risk relative to the existing stop (when known).
    if (stopLossPrice != null && Number.isFinite(stopLossPrice) && stopLossPrice > 0) {
      if (tick.positionSide === 'long' && px < stopLossPrice) {
        return { ok: false, error: 'Refusing to loosen stop for long (newStopPrice < current stop).' };
      }
      if (tick.positionSide === 'short' && px > stopLossPrice) {
        return { ok: false, error: 'Refusing to loosen stop for short (newStopPrice > current stop).' };
      }
    }

    // Stop should be on the loss-protection side of mark (or at mark in emergencies).
    if (tick.positionSide === 'long' && px > tick.markPrice) {
      return { ok: false, error: 'Refusing stop above current mark for long.' };
    }
    if (tick.positionSide === 'short' && px < tick.markPrice) {
      return { ok: false, error: 'Refusing stop below current mark for short.' };
    }
    return { ok: true };
  }

  return { ok: false, error: 'Unknown action.' };
}

async function fetchHeartbeatConfig(config: ThufirConfig): Promise<{
  enabled: boolean;
  tickIntervalSeconds: number;
  rollingBufferSize: number;
  triggers: HeartbeatTriggerConfig;
  llm: { provider: 'anthropic' | 'openai' | null; model: string | null; maxTokens: number; maxCallsPerHour: number };
}> {
  const hb = (config as any).heartbeat ?? {};
  const enabled = hb.enabled === true;
  const tickIntervalSeconds = Math.max(5, Number(hb.tickIntervalSeconds ?? 30));
  const rollingBufferSize = Math.max(10, Math.min(1000, Number(hb.rollingBufferSize ?? 60)));
  const triggersRaw = hb.triggers ?? {};
  const triggers: HeartbeatTriggerConfig = {
    pnlShiftPct: Number(triggersRaw.pnlShiftPct ?? 1.5),
    approachingStopPct: Number(triggersRaw.approachingStopPct ?? 1.0),
    approachingTpPct: Number(triggersRaw.approachingTpPct ?? 1.0),
    liquidationProximityPct: Number(triggersRaw.liquidationProximityPct ?? 5.0),
    fundingSpike: Number(triggersRaw.fundingSpike ?? 0.0001),
    volatilitySpikePct: Number(triggersRaw.volatilitySpikePct ?? 2.0),
    volatilitySpikeWindowTicks: Number(triggersRaw.volatilitySpikeWindowTicks ?? 10),
    timeCeilingMinutes: Number(triggersRaw.timeCeilingMinutes ?? 15),
    triggerCooldownSeconds: Number(triggersRaw.triggerCooldownSeconds ?? 180),
  };
  const llmRaw = hb.llm ?? {};
  const providerRaw = llmRaw.provider === 'anthropic' || llmRaw.provider === 'openai' ? llmRaw.provider : null;
  const modelRaw = typeof llmRaw.model === 'string' && llmRaw.model.trim().length > 0 ? llmRaw.model.trim() : null;
  const maxTokens = Math.max(128, Math.min(8192, Number(llmRaw.maxTokens ?? 1024)));
  const maxCallsPerHour = Math.max(1, Math.min(200, Number(llmRaw.maxCallsPerHour ?? 20)));
  return { enabled, tickIntervalSeconds, rollingBufferSize, triggers, llm: { provider: providerRaw, model: modelRaw, maxTokens, maxCallsPerHour } };
}

export class PositionHeartbeatService {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private logger: Logger;
  private llm: LlmClient;
  private buffers = new Map<string, PositionTick[]>();
  private states = new Map<string, TriggerState>();
  private lastOpenSymbols = new Set<string>();
  private llmWindow = { hourStartMs: 0, calls: 0 };

  constructor(
    private params: {
      toolContext: ToolExecutorContext;
      logger?: Logger;
      llm?: LlmClient;
      hyperliquidClientFactory?: (config: ThufirConfig) => HyperliquidClient;
    }
  ) {
    this.logger = params.logger ?? new Logger('info');
    const cfg = params.toolContext.config;
    const hb = (cfg as any).heartbeat ?? {};
    const provider = hb?.llm?.provider ?? null;
    const model = hb?.llm?.model ?? null;
    this.llm = params.llm ?? createExecutorClient(cfg, model ?? undefined, provider ?? undefined);
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.scheduleNext(1);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delaySeconds: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => this.logger.error('Position heartbeat tick failed', err))
        .finally(async () => {
          // Dynamic schedule: fast when positions open, slow when flat.
          const { enabled, tickIntervalSeconds } = await fetchHeartbeatConfig(this.params.toolContext.config);
          const next = !enabled ? 60 : this.lastOpenSymbols.size > 0 ? tickIntervalSeconds : Math.max(60, tickIntervalSeconds * 5);
          this.scheduleNext(next);
        });
    }, Math.max(1, delaySeconds) * 1000);
  }

  private noteLlmCall(nowMs: number): void {
    const hourStart = Math.floor(nowMs / 3_600_000) * 3_600_000;
    if (this.llmWindow.hourStartMs !== hourStart) {
      this.llmWindow = { hourStartMs: hourStart, calls: 0 };
    }
    this.llmWindow.calls += 1;
  }

  private canCallLlm(nowMs: number, maxCallsPerHour: number): boolean {
    const hourStart = Math.floor(nowMs / 3_600_000) * 3_600_000;
    if (this.llmWindow.hourStartMs !== hourStart) {
      this.llmWindow = { hourStartMs: hourStart, calls: 0 };
    }
    return this.llmWindow.calls < maxCallsPerHour;
  }

  async tick(): Promise<void> {
    const config = this.params.toolContext.config;
    const hb = await fetchHeartbeatConfig(config);
    if (!hb.enabled) return;

    // Layer 1: data poller
    const client = this.params.hyperliquidClientFactory?.(config) ?? new HyperliquidClient(config);
    const pollOpts = {
      retries: 4,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      jitterMs: 250,
      isRetryable: isRetryableHyperliquidPollError,
      onRetry: (info: { attempt: number; retriesLeft: number; delayMs: number; error: unknown }) => {
        this.logger.warn(
          `Heartbeat: Hyperliquid poll retry ${info.attempt} (retriesLeft=${info.retriesLeft}) after ${info.delayMs}ms`,
          info.error
        );
      },
    };

    const stateRes = await retryWithBackoff(async () => client.getClearinghouseState(), pollOpts);
    if (!stateRes.ok) {
      this.logger.warn(
        `Heartbeat degraded: clearinghouseState poll failed after ${stateRes.attempts} attempt(s); skipping tick`,
        stateRes.error
      );
      recordPositionHeartbeatDecision({
        kind: 'position_heartbeat',
        symbol: '_system',
        timestamp: new Date().toISOString(),
        triggers: ['data_poll_failed'],
        decision: { action: 'hold', reason: 'Degraded mode: failed to poll Hyperliquid clearinghouse state.' },
        snapshot: { attempts: stateRes.attempts, error: String((stateRes.error as any)?.message ?? stateRes.error) },
        outcome: 'skipped',
      });
      return;
    }

    const midsRes = await retryWithBackoff(async () => client.getAllMids(), pollOpts);
    if (!midsRes.ok) {
      this.logger.warn(
        `Heartbeat degraded: allMids poll failed after ${midsRes.attempts} attempt(s); skipping tick`,
        midsRes.error
      );
      recordPositionHeartbeatDecision({
        kind: 'position_heartbeat',
        symbol: '_system',
        timestamp: new Date().toISOString(),
        triggers: ['data_poll_failed'],
        decision: { action: 'hold', reason: 'Degraded mode: failed to poll Hyperliquid mids.' },
        snapshot: { attempts: midsRes.attempts, error: String((midsRes.error as any)?.message ?? midsRes.error) },
        outcome: 'skipped',
      });
      return;
    }

    const state = stateRes.value as {
      assetPositions?: Array<{ position?: Record<string, unknown> }>;
      marginSummary?: Record<string, unknown>;
    };
    const mids = midsRes.value;

    const openOrdersRes = await retryWithBackoff(async () => client.getOpenOrders(), {
      ...pollOpts,
      retries: 2,
      baseDelayMs: 250,
      maxDelayMs: 2000,
      jitterMs: 100,
    });
    const openOrders = openOrdersRes.ok
      ? openOrdersRes.value
      : (() => {
          this.logger.warn('Heartbeat: failed to load open orders; proceeding without SL/TP parsing', openOrdersRes.error);
          return [];
        })();

    const fundingBySymbol = await this.loadFundingRates(client).catch(() => new Map<string, number>());

    const accountEquity =
      toFiniteNumber((state.marginSummary ?? {}).accountValue) ??
      // Conservative fallback: avoid divide-by-zero in pnlPctOfEquity.
      0;

    const positions = this.parsePositions(state).map((p): HeartbeatPosition | null => {
      const symbol = normalizeSymbol(p.symbol);
      const mid = Number(mids[symbol]);
      if (!Number.isFinite(mid) || mid <= 0) return null;
      const entry = p.entryPrice;
      const liq = p.liquidationPrice;
      const unreal = p.unrealizedPnl;
      if (!Number.isFinite(entry) || entry <= 0) return null;
      if (!Number.isFinite(liq) || liq <= 0) return null;
      if (!Number.isFinite(unreal)) return null;
      return {
        symbol,
        positionSide: p.positionSide,
        positionSize: p.positionSize,
        entryPrice: entry,
        liquidationPrice: liq,
        unrealizedPnl: unreal,
      };
    }).filter((p): p is HeartbeatPosition => Boolean(p));

    const currentSymbols = new Set(positions.map((p) => p.symbol));
    // position_closed triggers (no tick to compute, but still journal + state cleanup)
    for (const prev of this.lastOpenSymbols) {
      if (!currentSymbols.has(prev)) {
        recordPositionHeartbeatDecision({
          kind: 'position_heartbeat',
          symbol: prev,
          timestamp: new Date().toISOString(),
          triggers: ['position_closed'],
          decision: { action: 'hold', reason: 'Position closed (detected by heartbeat).' },
          snapshot: { symbol: prev },
          outcome: 'info',
        });
        this.buffers.delete(prev);
        this.states.delete(prev);
      }
    }

    // Layer 1 polling should be active only while positions are open; if flat, just update lastOpenSymbols.
    this.lastOpenSymbols = currentSymbols;
    if (positions.length === 0) return;

    const nowMs = Date.now();
    for (const pos of positions) {
      const mid = Number(mids[pos.symbol]);
      if (!Number.isFinite(mid) || mid <= 0) continue;
      const orders = parseOpenOrdersForSymbol(openOrders, pos.symbol);
      const fundingRate = fundingBySymbol.get(pos.symbol) ?? 0;
      const distToLiq = pctDist(mid, pos.liquidationPrice);
      const pnlPctOfEquity = accountEquity > 0 ? (pos.unrealizedPnl / accountEquity) * 100 : 0;
      const tick: PositionTick = {
        timestamp: nowMs,
        symbol: pos.symbol,
        markPrice: mid,
        entryPrice: pos.entryPrice,
        unrealizedPnl: pos.unrealizedPnl,
        pnlPctOfEquity,
        accountEquity,
        liquidationPrice: pos.liquidationPrice,
        distToLiquidationPct: distToLiq,
        fundingRate,
        stopLossPrice: orders.stopLossPrice,
        takeProfitPrice: orders.takeProfitPrice,
        positionSide: pos.positionSide,
        positionSize: pos.positionSize,
      };

      const buffer = this.buffers.get(pos.symbol) ?? [];
      buffer.push(tick);
      if (buffer.length > hb.rollingBufferSize) buffer.splice(0, buffer.length - hb.rollingBufferSize);
      this.buffers.set(pos.symbol, buffer);

      const prevState = this.states.get(pos.symbol) ?? defaultTriggerState(nowMs);
      const evalResult = evaluateHeartbeatTriggers({
        nowMs,
        tick,
        buffer,
        state: prevState,
        cfg: hb.triggers,
        extra: { positionOpened: prevState.lastLlmCheckTimestamp === 0 },
      });
      this.states.set(pos.symbol, evalResult.nextState);

      if (evalResult.fired.length === 0) continue;

      // Hard circuit breakers (no LLM).
      if (tick.distToLiquidationPct < 2) {
        await this.emergencyClose(tick, `Emergency close: distToLiquidationPct=${tick.distToLiquidationPct.toFixed(2)}%`, [
          'liquidation_proximity',
        ]);
        continue;
      }
      if (tick.pnlPctOfEquity < -5) {
        await this.emergencyClose(tick, `Emergency close: pnlPctOfEquity=${tick.pnlPctOfEquity.toFixed(2)}%`, [
          'pnl_shift',
        ]);
        continue;
      }

      // Layer 3: LLM decision (rate-limited).
      if (!this.canCallLlm(nowMs, hb.llm.maxCallsPerHour)) {
        recordPositionHeartbeatDecision({
          kind: 'position_heartbeat',
          symbol: tick.symbol,
          timestamp: new Date(nowMs).toISOString(),
          triggers: evalResult.fired.map((t) => t.name),
          decision: { action: 'hold', reason: 'LLM rate-limit reached for heartbeat; skipping LLM.' },
          snapshot: { tick },
          outcome: 'skipped',
        });
        continue;
      }

      const action = await this.askLlmForAction({
        tick,
        triggers: evalResult.fired,
        buffer,
        maxTokens: hb.llm.maxTokens,
      });
      this.noteLlmCall(nowMs);

      const validation = validateAction({ action, tick, stopLossPrice: orders.stopLossPrice });
      if (!validation.ok) {
        recordPositionHeartbeatDecision({
          kind: 'position_heartbeat',
          symbol: tick.symbol,
          timestamp: new Date(nowMs).toISOString(),
          triggers: evalResult.fired.map((t) => t.name),
          decision: action,
          snapshot: { tick, validation },
          outcome: 'rejected',
        });
        continue;
      }

      await this.executeAction({ tick, action, orders, triggers: evalResult.fired });

      // Update trigger state "last LLM check" fields after a successful decision cycle.
      const st = this.states.get(pos.symbol) ?? defaultTriggerState(nowMs);
      st.lastLlmCheckTimestamp = nowMs;
      st.lastLlmPnlPctOfEquity = tick.pnlPctOfEquity;
      st.lastLlmMarkPrice = tick.markPrice;
      st.lastFundingRateSign = sign(tick.fundingRate);
      this.states.set(pos.symbol, st);
    }
  }

  private parsePositions(state: unknown): Array<{
    symbol: string;
    positionSide: PositionSide;
    positionSize: number;
    entryPrice: number;
    liquidationPrice: number;
    unrealizedPnl: number;
  }> {
    const raw = state as { assetPositions?: Array<{ position?: Record<string, unknown> }> };
    const out: Array<HeartbeatPosition> = [];
    for (const entry of raw.assetPositions ?? []) {
      const p = entry?.position ?? {};
      const szi = toFiniteNumber((p as any).szi);
      if (szi == null || szi === 0) continue;
      const symbol = String((p as any).coin ?? '');
      const positionSide: PositionSide = szi > 0 ? 'long' : 'short';
      const positionSize = Math.abs(szi);
      const entryPrice = toFiniteNumber((p as any).entryPx) ?? NaN;
      const liquidationPrice = toFiniteNumber((p as any).liquidationPx) ?? NaN;
      const unrealizedPnl = toFiniteNumber((p as any).unrealizedPnl) ?? NaN;
      if (!symbol) continue;
      if (!Number.isFinite(entryPrice) || !Number.isFinite(liquidationPrice) || !Number.isFinite(unrealizedPnl)) continue;
      out.push({ symbol, positionSide, positionSize, entryPrice, liquidationPrice, unrealizedPnl });
    }
    return out;
  }

  private async loadFundingRates(client: HyperliquidClient): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const respRes = await retryWithBackoff(async () => client.getMetaAndAssetCtxs(), {
      retries: 3,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      jitterMs: 250,
      isRetryable: isRetryableHyperliquidPollError,
      onRetry: (info: { attempt: number; retriesLeft: number; delayMs: number; error: unknown }) => {
        this.logger.warn(
          `Heartbeat: metaAndAssetCtxs retry ${info.attempt} (retriesLeft=${info.retriesLeft}) after ${info.delayMs}ms`,
          info.error
        );
      },
    });
    if (!respRes.ok) {
      // Non-fatal: funding is advisory for triggers; proceed without it.
      this.logger.warn(
        `Heartbeat degraded: metaAndAssetCtxs poll failed after ${respRes.attempts} attempt(s); funding triggers disabled this tick`,
        respRes.error
      );
      return out;
    }
    const resp = respRes.value as any;
    const meta = Array.isArray(resp) ? resp[0] : null;
    const ctxs = Array.isArray(resp) ? resp[1] : null;
    const universe = Array.isArray(meta?.universe) ? meta.universe : [];
    const assetCtxs = Array.isArray(ctxs) ? ctxs : [];
    for (let i = 0; i < universe.length; i++) {
      const sym = normalizeSymbol(String(universe[i]?.name ?? ''));
      if (!sym) continue;
      const ctx = assetCtxs[i] ?? {};
      const rate =
        toFiniteNumber((ctx as any).funding) ??
        toFiniteNumber((ctx as any).fundingRate) ??
        toFiniteNumber((ctx as any).fundingRatePerHour) ??
        0;
      out.set(sym, rate);
    }
    return out;
  }

  private async askLlmForAction(params: {
    tick: PositionTick;
    triggers: HeartbeatTriggerFired[];
    buffer: PositionTick[];
    maxTokens: number;
  }): Promise<HeartbeatAction> {
    const thesis = await this.loadThesis(params.tick.symbol);
    const prompt = [
      `## Position Heartbeat Alert`,
      ``,
      `**Trigger(s):**`,
      summarizeTriggers(params.triggers),
      ``,
      `### Current Position`,
      `- Symbol: ${params.tick.symbol}`,
      `- Side: ${params.tick.positionSide}`,
      `- Entry: ${params.tick.entryPrice}`,
      `- Current: ${params.tick.markPrice}`,
      `- Unrealized PnL: ${params.tick.unrealizedPnl} USDC (${params.tick.pnlPctOfEquity.toFixed(2)}% of equity)`,
      `- Stop-loss: ${params.tick.stopLossPrice ?? 'null'} (distance: ${
        params.tick.stopLossPrice != null ? pctDist(params.tick.markPrice, params.tick.stopLossPrice).toFixed(2) : 'n/a'
      }%)`,
      `- Take-profit: ${params.tick.takeProfitPrice ?? 'null'} (distance: ${
        params.tick.takeProfitPrice != null ? pctDist(params.tick.markPrice, params.tick.takeProfitPrice).toFixed(2) : 'n/a'
      }%)`,
      `- Liquidation: ${params.tick.liquidationPrice} (distance: ${params.tick.distToLiquidationPct.toFixed(2)}%)`,
      `- Funding rate: ${params.tick.fundingRate}`,
      ``,
      `### Recent Price Trajectory`,
      formatTrajectory(params.buffer, 30),
      ``,
      `### Original Trade Thesis`,
      thesis ?? 'Not recorded',
      ``,
      `### Your task`,
      `Evaluate whether to:`,
      `1. Hold`,
      `2. Tighten stop`,
      `3. Take partial profit`,
      `4. Close entirely`,
      `5. Adjust take-profit`,
      ``,
      `Respond with a JSON action and a one-sentence reason. Valid actions: hold | tighten_stop | take_partial_profit | close_entirely | adjust_take_profit.`,
      `For tighten_stop: {"action":"tighten_stop","params":{"newStopPrice":123.45},"reason":"..."}`,
      `For adjust_take_profit: {"action":"adjust_take_profit","params":{"newTakeProfitPrice":123.45},"reason":"..."}`,
      `For take_partial_profit: {"action":"take_partial_profit","params":{"fraction":0.5},"reason":"..."} or {"size":0.01}`,
    ].join('\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a risk-reducing position manager. You MUST NOT increase risk. Never widen a stop-loss. Never add to position size. Output only JSON.',
      },
      { role: 'user', content: prompt },
    ];

    const response = await this.llm.complete(messages, {
      temperature: 0.2,
      maxTokens: params.maxTokens,
      timeoutMs: 30_000,
    });
    const parsed = extractFirstJsonObject(response.content);
    const fallback: HeartbeatAction = { action: 'hold', reason: 'Failed to parse JSON; holding.' };
    if (!parsed || typeof parsed !== 'object') return fallback;

    const obj = parsed as any;
    const action = String(obj.action ?? '').trim();
    const reason = typeof obj.reason === 'string' ? obj.reason : '';
    if (!reason) return fallback;

    if (action === 'hold') return { action: 'hold', reason };
    if (action === 'close_entirely') return { action: 'close_entirely', reason };
    if (action === 'tighten_stop') {
      const newStopPrice = Number(obj.params?.newStopPrice);
      return { action: 'tighten_stop', params: { newStopPrice }, reason };
    }
    if (action === 'adjust_take_profit') {
      const newTakeProfitPrice = Number(obj.params?.newTakeProfitPrice);
      return { action: 'adjust_take_profit', params: { newTakeProfitPrice }, reason };
    }
    if (action === 'take_partial_profit') {
      const fraction = obj.params?.fraction != null ? Number(obj.params.fraction) : undefined;
      const size = obj.params?.size != null ? Number(obj.params.size) : undefined;
      return { action: 'take_partial_profit', params: { fraction, size }, reason };
    }
    return fallback;
  }

  private async loadThesis(symbol: string): Promise<string | null> {
    try {
      const mod = await import('../trade-management/db.js');
      const env = mod.getOpenTradeEnvelopeBySymbol?.(symbol);
      return env?.thesis ?? null;
    } catch {
      return null;
    }
  }

  private async emergencyClose(
    tick: PositionTick,
    reason: string,
    triggers: HeartbeatTriggerName[]
  ): Promise<void> {
    await this.executeClose({
      tick,
      size: tick.positionSize,
      decision: { action: 'close_entirely', reason },
      triggers,
    });
  }

  private async executeAction(params: {
    tick: PositionTick;
    action: HeartbeatAction;
    orders: ParsedOrders;
    triggers: HeartbeatTriggerFired[];
  }): Promise<void> {
    const { tick, action, orders, triggers } = params;
    const nowIso = new Date(tick.timestamp).toISOString();

    if (action.action === 'hold') {
      recordPositionHeartbeatDecision({
        kind: 'position_heartbeat',
        symbol: tick.symbol,
        timestamp: nowIso,
        triggers: triggers.map((t) => t.name),
        decision: action,
        snapshot: { tick },
        outcome: 'ok',
      });
      return;
    }

    if (action.action === 'close_entirely') {
      await this.executeClose({
        tick,
        size: tick.positionSize,
        decision: action,
        triggers: triggers.map((t) => t.name),
      });
      return;
    }

    if (action.action === 'take_partial_profit') {
      const size =
        action.params.size != null
          ? action.params.size
          : action.params.fraction != null
            ? tick.positionSize * clamp(action.params.fraction, 0, 1)
            : 0;
      const safeSize = Math.min(tick.positionSize, Math.max(0, size));
      if (!Number.isFinite(safeSize) || safeSize <= 0) {
        recordPositionHeartbeatDecision({
          kind: 'position_heartbeat',
          symbol: tick.symbol,
          timestamp: nowIso,
          triggers: triggers.map((t) => t.name),
          decision: action,
          snapshot: { tick, error: 'Computed partial size <= 0' },
          outcome: 'rejected',
        });
        return;
      }
      await this.executeClose({
        tick,
        size: safeSize,
        decision: action,
        triggers: triggers.map((t) => t.name),
      });
      return;
    }

    if (action.action === 'tighten_stop') {
      const newPx = action.params.newStopPrice;
      const result = await this.replaceTriggerOrder({
        symbol: tick.symbol,
        positionSide: tick.positionSide,
        positionSize: tick.positionSize,
        kind: 'sl',
        newTriggerPrice: newPx,
        existingOid: orders.stopLossOid,
      });
      recordPositionHeartbeatDecision({
        kind: 'position_heartbeat',
        symbol: tick.symbol,
        timestamp: nowIso,
        triggers: triggers.map((t) => t.name),
        decision: action,
        snapshot: { tick, result },
        outcome: result.ok ? 'ok' : 'failed',
      });
      return;
    }

    if (action.action === 'adjust_take_profit') {
      const newPx = action.params.newTakeProfitPrice;
      const result = await this.replaceTriggerOrder({
        symbol: tick.symbol,
        positionSide: tick.positionSide,
        positionSize: tick.positionSize,
        kind: 'tp',
        newTriggerPrice: newPx,
        existingOid: orders.takeProfitOid,
      });
      recordPositionHeartbeatDecision({
        kind: 'position_heartbeat',
        symbol: tick.symbol,
        timestamp: nowIso,
        triggers: triggers.map((t) => t.name),
        decision: action,
        snapshot: { tick, result },
        outcome: result.ok ? 'ok' : 'failed',
      });
      return;
    }
  }

  private async executeClose(params: {
    tick: PositionTick;
    size: number;
    decision: HeartbeatAction;
    triggers: HeartbeatTriggerName[];
  }): Promise<void> {
    const tick = params.tick;
    const side = tick.positionSide === 'long' ? 'sell' : 'buy';
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol: tick.symbol,
        side,
        size: params.size,
        order_type: 'market',
        reduce_only: true,
        reasoning: `heartbeat:${params.decision.reason}`,
      },
      this.params.toolContext
    );
    recordPositionHeartbeatDecision({
      kind: 'position_heartbeat',
      symbol: tick.symbol,
      timestamp: new Date(tick.timestamp).toISOString(),
      triggers: params.triggers,
      decision: params.decision,
      snapshot: { tick, toolResult: res },
      outcome: res.success ? 'ok' : 'failed',
    });
  }

  private async replaceTriggerOrder(params: {
    symbol: string;
    positionSide: PositionSide;
    positionSize: number;
    kind: 'sl' | 'tp';
    newTriggerPrice: number;
    existingOid: string | null;
  }): Promise<{ ok: true; oid?: string } | { ok: false; error: string }> {
    const cfg = this.params.toolContext.config;
    if (cfg.execution?.mode !== 'live' || cfg.execution?.provider !== 'hyperliquid') {
      return { ok: false, error: 'Execution is not live hyperliquid; cannot place exchange-side trigger orders.' };
    }

    if (params.existingOid) {
      await executeToolCall('perp_cancel_order', { order_id: params.existingOid }, this.params.toolContext).catch(() => {});
      // Allow cancel to propagate before re-placing (best-effort).
      await sleep(250);
    }

    const client = new HyperliquidClient(cfg);
    const exchange = client.getExchangeClient();
    const markets = await client.listPerpMarkets();
    const marketMeta = markets.find((m) => m.symbol === params.symbol);
    if (!marketMeta) return { ok: false, error: `Unknown Hyperliquid symbol: ${params.symbol}` };
    const szDecimals = marketMeta.szDecimals ?? 0;
    const closeIsBuy = params.positionSide === 'short';

    let sizeStr = '';
    let pxStr = '';
    try {
      sizeStr = formatSize(params.positionSize, szDecimals);
    } catch {
      return { ok: false, error: 'Invalid size: rounds to zero.' };
    }
    try {
      pxStr = formatPrice(params.newTriggerPrice, szDecimals, 'perp');
    } catch {
      return { ok: false, error: 'Invalid trigger price (tick rules).' };
    }

    try {
      const payload: any = {
        orders: [
          {
            a: marketMeta.assetId,
            b: closeIsBuy,
            p: pxStr,
            s: sizeStr,
            r: true,
            t: { trigger: { isMarket: true, triggerPx: pxStr, tpsl: params.kind } },
          },
        ],
        grouping: 'na',
      };
      const result = await exchange.order(payload);
      const status = (result as any)?.response?.data?.statuses?.[0];
      const oid =
        status?.resting?.oid != null
          ? String(status.resting.oid)
          : status?.filled?.oid != null
            ? String(status.filled.oid)
            : undefined;
      const err = typeof status?.error === 'string' ? status.error : '';
      if (err) return { ok: false, error: err };
      return { ok: true, oid };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Unknown error placing trigger' };
    }
  }
}

function parseOpenOrdersForSymbol(openOrders: unknown, symbol: string): ParsedOrders {
  const sym = normalizeSymbol(symbol);
  const orders = Array.isArray(openOrders) ? openOrders : [];
  let sl: { px: number; oid: string } | null = null;
  let tp: { px: number; oid: string } | null = null;
  for (const o of orders) {
    if (!o || typeof o !== 'object') continue;
    const coin = normalizeSymbol(String((o as any).coin ?? ''));
    if (coin !== sym) continue;
    const tpsl = String((o as any).tpsl ?? (o as any).orderType ?? '').toLowerCase();
    const isTrigger = Boolean((o as any).isTrigger ?? (o as any).triggerPx != null);
    if (!isTrigger) continue;
    const oidRaw = (o as any).oid;
    const oid = oidRaw != null ? String(oidRaw) : '';
    const triggerPx =
      toFiniteNumber((o as any).triggerPx) ??
      toFiniteNumber((o as any).triggerPx?.toString?.()) ??
      toFiniteNumber((o as any).limitPx) ??
      null;
    if (!oid || triggerPx == null || triggerPx <= 0) continue;
    if (tpsl === 'sl') {
      if (!sl) sl = { px: triggerPx, oid };
    } else if (tpsl === 'tp') {
      if (!tp) tp = { px: triggerPx, oid };
    }
  }
  return {
    stopLossPrice: sl?.px ?? null,
    stopLossOid: sl?.oid ?? null,
    takeProfitPrice: tp?.px ?? null,
    takeProfitOid: tp?.oid ?? null,
  };
}

// Exported for unit tests.
export const _private = {
  extractFirstJsonObject,
  validateAction,
  parseOpenOrdersForSymbol,
};
