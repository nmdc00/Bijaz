import type { Logger } from '../core/logger.js';
import type { ThufirConfig } from '../core/config.js';
import type { ToolExecutorContext, ToolResult } from '../core/tool-executor.js';
import type { HyperliquidMarket } from '../execution/hyperliquid/client.js';
import { executeToolCall } from '../core/tool-executor.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import {
  computeBracketPrices,
  makeCloid,
  placeExchangeSideTpsl,
} from './hyperliquid-stops.js';
import {
  deleteTradeManagementState,
  getTradeManagementState,
  upsertTradeManagementState,
  type TradeManagementPositionState,
} from '../memory/trade_management_state.js';

type ToolExecutorFn = (
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
) => Promise<ToolResult>;

type PositionToolRow = {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entry_price: number | null;
  liquidation_price: number | null;
};

export class TradeMonitor {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private client: HyperliquidClient;
  private toolExec: ToolExecutorFn;
  private markets: HyperliquidMarket[] | null = null;

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
    this.scheduleNext(2000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tickOnce().catch((err) => this.logger.error('TradeMonitor tick failed', err));
    }, Math.max(250, Math.min(delayMs, 10 * 60 * 1000)));
  }

  async tickOnce(): Promise<void> {
    if (this.stopped) return;
    const tm = this.config.tradeManagement;
    if (!tm?.enabled) return;
    if ((this.config.execution?.mode ?? 'paper') !== 'live') return;
    if ((this.config.execution?.provider ?? 'hyperliquid') !== 'hyperliquid') return;

    const posRes = await this.toolExec('get_positions', {}, this.toolContext);
    if (!posRes.success) {
      this.scheduleNext((tm.monitorIntervalSeconds ?? 900) * 1000);
      return;
    }

    const positions = this.parsePositions(posRes.data);
    if (positions.length === 0) {
      this.scheduleNext((tm.monitorIntervalSeconds ?? 900) * 1000);
      return;
    }

    const mids = await this.safeGetAllMids();
    const openOrders = await this.safeGetOpenOrders();
    const markets = await this.ensureMarkets();
    const exchange = this.client.getExchangeClient();

    for (const pos of positions) {
      const entryPrice = pos.entry_price;
      if (!entryPrice || entryPrice <= 0) continue;

      let state = getTradeManagementState(pos.symbol);
      if (!state) {
        state = this.initializeStateFromPosition(pos, entryPrice);
        upsertTradeManagementState(state);
      }

      if (tm.useExchangeStops) {
        const hasSl = openOrders.some((o) => String((o as any)?.cloid ?? '') === state.slCloid);
        const hasTp = openOrders.some((o) => String((o as any)?.cloid ?? '') === state.tpCloid);
        if (!hasSl || !hasTp) {
          const marketMeta = markets.find((m) => m.symbol === pos.symbol);
          if (marketMeta) {
            const bracketPrices = computeBracketPrices({
              side: state.side,
              entryPrice,
              stopLossPct: state.stopLossPct,
              takeProfitPct: state.takeProfitPct,
            });
            if (bracketPrices.slPx > 0 && bracketPrices.tpPx > 0) {
              await placeExchangeSideTpsl({
                exchange,
                market: {
                  symbol: pos.symbol,
                  assetId: marketMeta.assetId,
                  szDecimals: marketMeta.szDecimals ?? 6,
                },
                bracket: {
                  symbol: pos.symbol,
                  side: state.side,
                  size: pos.size,
                  entryPrice,
                  stopLossPct: state.stopLossPct,
                  takeProfitPct: state.takeProfitPct,
                },
                slCloid: state.slCloid,
                tpCloid: state.tpCloid,
              });
            }
          }
        }
      }

      const liqDistBps = computeLiqDistanceBps({
        side: pos.side,
        mid: mids[pos.symbol] ?? mids[pos.symbol.toUpperCase()],
        liquidationPrice: pos.liquidation_price,
      });
      if (
        liqDistBps != null &&
        liqDistBps <= (tm.liquidationGuardDistanceBps ?? 800)
      ) {
        await this.flattenPosition(pos);
        deleteTradeManagementState(pos.symbol);
      }

      const now = Date.now();
      if (Date.parse(state.expiresAt) <= now) {
        await this.flattenPosition(pos);
        deleteTradeManagementState(pos.symbol);
      }
    }

    this.scheduleNext((tm.activeMonitorIntervalSeconds ?? 60) * 1000);
  }

  private parsePositions(raw: unknown): PositionToolRow[] {
    const positionsRaw = (raw as any)?.positions;
    const positions = Array.isArray(positionsRaw) ? positionsRaw : [];
    return positions
      .map((p: any): PositionToolRow => ({
        symbol: String(p?.symbol ?? ''),
        side: String(p?.side ?? '') === 'short' ? 'short' : 'long',
        size: Number(p?.size ?? 0),
        entry_price: p?.entry_price == null ? null : Number(p.entry_price),
        liquidation_price: p?.liquidation_price == null ? null : Number(p.liquidation_price),
      }))
      .filter((p: any) => p.symbol && Number.isFinite(p.size) && p.size > 0);
  }

  private initializeStateFromPosition(
    pos: PositionToolRow,
    entryPrice: number
  ): TradeManagementPositionState {
    const tm = this.config.tradeManagement ?? ({} as any);
    const defaults = tm.defaults ?? {};
    const bounds = tm.bounds ?? {};

    const stopLoss = clampNumber(
      Number(defaults.stopLossPct ?? 3),
      Number(bounds.stopLossPct?.min ?? 1),
      Number(bounds.stopLossPct?.max ?? 8)
    );
    const takeProfit = clampNumber(
      Number(defaults.takeProfitPct ?? 5),
      Number(bounds.takeProfitPct?.min ?? 2),
      Number(bounds.takeProfitPct?.max ?? 15)
    );
    const holdHours = clampNumber(
      Number(defaults.maxHoldHours ?? 72),
      Number(bounds.maxHoldHours?.min ?? 1),
      Number(bounds.maxHoldHours?.max ?? 168)
    );

    const enteredAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + holdHours * 60 * 60 * 1000).toISOString();
    return {
      symbol: pos.symbol,
      side: pos.side,
      enteredAt,
      expiresAt,
      entryPrice,
      stopLossPct: stopLoss,
      takeProfitPct: takeProfit,
      slCloid: makeCloid(),
      tpCloid: makeCloid(),
    };
  }

  private async ensureMarkets(): Promise<HyperliquidMarket[]> {
    if (this.markets) return this.markets;
    this.markets = await this.client.listPerpMarkets();
    return this.markets;
  }

  private async safeGetAllMids(): Promise<Record<string, number>> {
    try {
      return await this.client.getAllMids();
    } catch {
      return {};
    }
  }

  private async safeGetOpenOrders(): Promise<unknown[]> {
    try {
      const raw = await this.client.getOpenOrders();
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  private async flattenPosition(pos: PositionToolRow): Promise<void> {
    const side = pos.side === 'long' ? 'sell' : 'buy';
    try {
      await this.toolExec(
        'perp_place_order',
        { symbol: pos.symbol, side, size: pos.size, reduce_only: true, order_type: 'market' },
        this.toolContext
      );
    } catch (error) {
      this.logger.error(`TradeMonitor: failed to flatten ${pos.symbol}`, error);
    }
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function computeLiqDistanceBps(params: {
  side: 'long' | 'short';
  mid?: number;
  liquidationPrice: number | null;
}): number | null {
  const mid = params.mid;
  const liq = params.liquidationPrice;
  if (mid == null || !Number.isFinite(mid) || mid <= 0) return null;
  if (liq == null || !Number.isFinite(liq) || liq <= 0) return null;
  const dist = params.side === 'long' ? (mid - liq) / mid : (liq - mid) / mid;
  return dist * 10000;
}
