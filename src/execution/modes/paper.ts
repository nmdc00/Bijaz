import type { ExecutionAdapter, TradeDecision, TradeResult, Order } from '../executor.js';
import type { Market } from '../markets.js';
import { logWalletOperation } from '../../memory/audit.js';
import { createPrediction, recordExecution } from '../../memory/predictions.js';
import { recordTrade } from '../../memory/trades.js';
import { recordPerpTrade } from '../../memory/perp_trades.js';
import { cancelPaperPerpOrder, getPaperPerpBookSummary, listPaperPerpOpenOrders, placePaperPerpOrder } from '../../memory/paper_perps.js';

export interface PaperExecutorOptions {
  initialCashUsdc?: number;
}

export class PaperExecutor implements ExecutionAdapter {
  private initialCashUsdc: number;

  constructor(options?: PaperExecutorOptions) {
    this.initialCashUsdc = Number.isFinite(Number(options?.initialCashUsdc))
      ? Number(options?.initialCashUsdc)
      : 200;
  }

  async execute(market: Market, decision: TradeDecision): Promise<TradeResult> {
    if (decision.action === 'hold') {
      return { executed: false, message: 'Hold decision; no trade executed.' };
    }

    if (market.kind === 'perp' || decision.symbol) {
      const symbol = decision.symbol ?? market.symbol ?? market.id;
      const side = decision.side ?? decision.action;
      const size = decision.size ?? decision.amount;
      if (!symbol || !side || !size) {
        return { executed: false, message: 'Invalid decision: missing symbol/side/size.' };
      }
      const markPrice = Number(market.markPrice ?? NaN);
      if (!Number.isFinite(markPrice) || markPrice <= 0) {
        return { executed: false, message: `Invalid decision: missing mark price for ${symbol}.` };
      }

      const orderType = decision.orderType ?? 'market';
      const limitPrice = orderType === 'limit' ? Number(decision.price ?? NaN) : undefined;
      if (orderType === 'limit' && (!Number.isFinite(limitPrice) || (limitPrice ?? 0) <= 0)) {
        return { executed: false, message: 'Invalid decision: missing or invalid price.' };
      }

      const fill = placePaperPerpOrder(
        {
          symbol,
          side,
          size,
          orderType,
          price: limitPrice,
          markPrice,
          leverage: decision.leverage ?? null,
          reduceOnly: decision.reduceOnly ?? false,
        },
        { initialCashUsdc: this.initialCashUsdc }
      );

      recordPerpTrade({
        symbol,
        side,
        size,
        price: fill.fillPrice ?? limitPrice ?? markPrice,
        leverage: decision.leverage ?? null,
        orderType,
        status: 'paper',
      });
      const book = getPaperPerpBookSummary(this.initialCashUsdc);
      logWalletOperation({
        operation: 'paper',
        amount: size,
        status: 'confirmed',
        metadata: {
          symbol,
          side,
          leverage: decision.leverage,
          order_id: fill.orderId,
          paper_cash_usdc: book.cashBalanceUsdc,
          realized_pnl_usdc: fill.realizedPnlUsd,
        },
      });
      return {
        executed: true,
        message: `${fill.message} symbol=${symbol} side=${side} size=${size}`,
      };
    }

    if (!decision.amount || !decision.outcome) {
      return { executed: false, message: 'Invalid decision: missing amount/outcome.' };
    }

    const predictionId = createPrediction({
      marketId: market.id,
      marketTitle: market.question,
      predictedOutcome: decision.outcome,
      predictedProbability: market.prices?.[decision.outcome] ?? undefined,
      confidenceLevel: decision.confidence,
      reasoning: decision.reasoning,
    });

    recordExecution({
      id: predictionId,
      executionPrice: market.prices?.[decision.outcome] ?? null,
      positionSize: decision.amount,
      cashDelta: decision.action === 'sell' ? decision.amount : -decision.amount,
    });

    const price = market.prices?.[decision.outcome] ?? null;
    const shares = price && price > 0 ? decision.amount / price : null;
    recordTrade({
      predictionId,
      marketId: market.id,
      marketTitle: market.question,
      outcome: decision.outcome,
      side: decision.action,
      price,
      amount: decision.amount,
      shares,
    });

    logWalletOperation({
      operation: 'paper',
      amount: decision.amount,
      status: 'confirmed',
      metadata: {
        marketId: market.id,
        outcome: decision.outcome,
        confidence: decision.confidence,
      },
    });

    return {
      executed: true,
      message: `Paper trade executed for ${market.id} (${decision.outcome})`,
    };
  }

  async getOpenOrders(): Promise<Order[]> {
    return listPaperPerpOpenOrders(this.initialCashUsdc).map((order) => ({
      id: order.id,
      marketId: order.symbol,
      side: order.side,
      price: order.price,
      amount: order.size,
      status: 'open',
      createdAt: order.createdAt,
    }));
  }

  async cancelOrder(_id: string, _options?: { symbol?: string }): Promise<void> {
    cancelPaperPerpOrder(_id, this.initialCashUsdc);
  }
}
