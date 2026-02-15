import type { ThufirConfig } from './config.js';
import type { Logger } from './logger.js';
import type { ToolExecutorContext, ToolResult } from './tool-executor.js';
import { executeToolCall } from './tool-executor.js';

import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import {
  evaluateHeartbeatTriggers,
  type HeartbeatPoint,
  type HeartbeatTriggerConfig,
  type HeartbeatTriggerName,
} from './heartbeat_triggers.js';
import { recordPositionHeartbeatDecision } from '../memory/position_heartbeat_journal.js';

type ToolExecutorFn = (
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
) => Promise<ToolResult>;

type PositionSnapshot = {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  unrealizedPnl: number | null;
  roePct: number | null;
  liquidationPrice: number | null;
};

export class PositionHeartbeatService {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  private bufferBySymbol = new Map<string, HeartbeatPoint[]>();
  private triggerStateBySymbol = new Map<string, Map<HeartbeatTriggerName, number>>();

  private client: HyperliquidClient;
  private toolExec: ToolExecutorFn;

  constructor(
    private config: ThufirConfig,
    private toolContext: ToolExecutorContext,
    private logger: Logger,
    options?: { client?: HyperliquidClient; toolExec?: ToolExecutorFn }
  ) {
    this.client = options?.client ?? new HyperliquidClient(config);
    this.toolExec = options?.toolExec ?? executeToolCall;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.logger.info('PositionHeartbeat: started');
    this.scheduleNext(1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('PositionHeartbeat: stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const bounded = Math.max(250, Math.min(delayMs, 10 * 60 * 1000));
    this.timer = setTimeout(() => {
      // Clear before running so tickOnce can schedule the next interval cleanly.
      this.timer = null;
      this.tickOnce().catch((err) => this.logger.error('PositionHeartbeat: tick failed', err));
    }, bounded);
  }

  async tickOnce(): Promise<void> {
    if (this.stopped) return;

    const hb = this.config.heartbeat;
    if (!hb?.enabled) return;
    if ((this.config.execution?.mode ?? 'paper') !== 'live') return;
    if ((this.config.execution?.provider ?? 'hyperliquid') !== 'hyperliquid') return;

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const posResult = await this.toolExec('get_positions', {}, this.toolContext);
    if (!posResult.success) {
      this.recordInfo('*', nowIso, [], `get_positions: ${posResult.error}`);
      this.scheduleNext(this.computeIdleIntervalMs());
      return;
    }

    const positions = this.parsePositions(posResult.data);
    if (positions.length === 0) {
      this.scheduleNext(this.computeIdleIntervalMs());
      return;
    }

    let mids: Record<string, number> = {};
    try {
      mids = await retryWithBackoff(() => this.client.getAllMids(), 3);
    } catch (err) {
      this.logger.warn(`PositionHeartbeat: failed to load mids: ${stringifyError(err)}`);
    }

    const cfg = normalizeTriggerConfig(this.config);
    for (const pos of positions) {
      const mid = resolveMid(mids, pos.symbol);
      const liqDistPct = computeLiqDistancePct({
        side: pos.side,
        mid,
        liquidationPrice: pos.liquidationPrice,
      });

      const point: HeartbeatPoint = { ts: nowMs, mid, roePct: pos.roePct, liqDistPct };
      const buffer = this.bufferBySymbol.get(pos.symbol) ?? [];
      buffer.push(point);
      const max = Math.max(5, Number(hb.rollingBufferSize ?? 60) || 60);
      if (buffer.length > max) buffer.splice(0, buffer.length - max);
      this.bufferBySymbol.set(pos.symbol, buffer);

      const triggerState =
        this.triggerStateBySymbol.get(pos.symbol) ?? new Map<HeartbeatTriggerName, number>();
      this.triggerStateBySymbol.set(pos.symbol, triggerState);
      const fired = evaluateHeartbeatTriggers({
        points: buffer,
        cfg,
        nowMs,
        lastFiredByTrigger: triggerState,
      });

      // Hard circuit breakers (no LLM).
      const emergency = liqDistPct != null && liqDistPct < 2;
      if (!emergency) {
        this.recordInfo(pos.symbol, nowIso, fired, null);
        continue;
      }

      const side = pos.side === 'long' ? 'sell' : 'buy';
      const tool = await this.toolExec(
        'perp_place_order',
        { symbol: pos.symbol, side, size: pos.size, reduce_only: true, order_type: 'market' },
        this.toolContext
      );

      recordPositionHeartbeatDecision({
        kind: 'position_heartbeat_journal',
        symbol: pos.symbol,
        timestamp: nowIso,
        triggers: fired,
        decision: {
          action: 'close_entirely',
          reason: `Emergency close: liqDistPct=${liqDistPct ?? 'n/a'}`,
        },
        outcome: tool.success ? 'ok' : 'failed',
        snapshot: { liqDistPct, tool },
        error: tool.success ? null : tool.error,
      });
    }

    this.scheduleNext(this.computeActiveIntervalMs());
  }

  private parsePositions(raw: unknown): PositionSnapshot[] {
    const positionsRaw = (raw as any)?.positions;
    const positions = Array.isArray(positionsRaw) ? positionsRaw : [];
    return positions
      .map((p: any): PositionSnapshot | null => {
        const symbol = String(p?.symbol ?? '').trim();
        if (!symbol) return null;
        const side = String(p?.side ?? '') === 'short' ? 'short' : 'long';
        const size = toFinite(p?.size);
        if (size == null || size <= 0) return null;
        return {
          symbol,
          side,
          size,
          unrealizedPnl: toFinite(p?.unrealized_pnl),
          roePct: toFinite(p?.return_on_equity),
          liquidationPrice: toFinite(p?.liquidation_price),
        };
      })
      .filter((p: any): p is PositionSnapshot => Boolean(p));
  }

  private recordInfo(
    symbol: string,
    timestamp: string,
    triggers: HeartbeatTriggerName[],
    message: string | null
  ): void {
    try {
      recordPositionHeartbeatDecision({
        kind: 'position_heartbeat_journal',
        symbol,
        timestamp,
        triggers,
        decision: { action: 'hold', reason: message ?? 'hold' },
        outcome: message ? 'failed' : 'info',
        snapshot: null,
        error: message,
      });
    } catch {
      // Best-effort only.
    }
  }

  private computeActiveIntervalMs(): number {
    const hb = this.config.heartbeat ?? ({} as any);
    return Math.max(1, Number(hb.tickIntervalSeconds ?? 30) || 30) * 1000;
  }

  private computeIdleIntervalMs(): number {
    return Math.max(60_000, this.computeActiveIntervalMs() * 5);
  }
}

function toFinite(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function resolveMid(mids: Record<string, number>, symbol: string): number | null {
  const direct = mids[symbol];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const upper = symbol.toUpperCase();
  const normalized = mids[upper];
  if (typeof normalized === 'number' && Number.isFinite(normalized)) return normalized;
  return null;
}

function computeLiqDistancePct(params: {
  side: 'long' | 'short';
  mid: number | null;
  liquidationPrice: number | null;
}): number | null {
  if (params.mid == null || params.mid <= 0) return null;
  if (params.liquidationPrice == null || params.liquidationPrice <= 0) return null;
  const mid = params.mid;
  const liq = params.liquidationPrice;
  const dist = params.side === 'long' ? (mid - liq) / mid : (liq - mid) / mid;
  return dist * 100;
}

function normalizeTriggerConfig(config: ThufirConfig): HeartbeatTriggerConfig {
  const raw = config.heartbeat?.triggers ?? ({} as any);
  return {
    pnlShiftPct: Number(raw.pnlShiftPct ?? 1.5) || 1.5,
    liquidationProximityPct: Number(raw.liquidationProximityPct ?? 5) || 5,
    volatilitySpikePct: Number(raw.volatilitySpikePct ?? 2) || 2,
    volatilitySpikeWindowTicks: Number(raw.volatilitySpikeWindowTicks ?? 10) || 10,
    timeCeilingMinutes: Number(raw.timeCeilingMinutes ?? 15) || 15,
    triggerCooldownSeconds: Number(raw.triggerCooldownSeconds ?? 180) || 180,
  };
}

async function retryWithBackoff<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  const max = Math.max(1, attempts);
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = Math.min(5000, 200 * Math.pow(2, i));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

