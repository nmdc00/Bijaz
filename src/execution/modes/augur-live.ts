import { ethers } from 'ethers';

import type { ExecutionAdapter, TradeDecision, TradeResult, Order } from '../executor.js';
import type { Market } from '../markets.js';
import type { ThufirConfig } from '../../core/config.js';

import { AugurAMMTrader } from '../augur/amm.js';
import { SpendingLimitEnforcer } from '../wallet/limits.js';
import { loadWallet } from '../wallet/manager.js';
import { createPrediction, recordExecution } from '../../memory/predictions.js';
import { recordTrade } from '../../memory/trades.js';
import { logWalletOperation } from '../../memory/audit.js';

export interface AugurLiveExecutorOptions {
  config: ThufirConfig;
  password: string;
}

export class AugurLiveExecutor implements ExecutionAdapter {
  private wallet: ethers.Wallet;
  private trader: AugurAMMTrader;
  private limits: SpendingLimitEnforcer;
  private slippage: number;

  constructor(options: AugurLiveExecutorOptions) {
    this.wallet = loadWallet(options.config, options.password);
    this.trader = new AugurAMMTrader(this.wallet);
    this.limits = new SpendingLimitEnforcer({
      daily: options.config.wallet?.limits?.daily ?? 100,
      perTrade: options.config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: options.config.wallet?.limits?.confirmationThreshold ?? 10,
    });
    this.slippage = options.config.augur?.slippageTolerance ?? 0.02;
  }

  async execute(market: Market, decision: TradeDecision): Promise<TradeResult> {
    if (decision.action === 'hold') {
      return { executed: false, message: 'Hold decision; no trade executed.' };
    }

    if (!decision.amount || !decision.outcome) {
      return { executed: false, message: 'Invalid decision: missing amount or outcome.' };
    }

    if (!market.augur) {
      return { executed: false, message: 'Market missing Augur metadata.' };
    }

    const limitCheck = await this.limits.checkAndReserve(decision.amount);
    if (!limitCheck.allowed) {
      return { executed: false, message: limitCheck.reason ?? 'Trade blocked by limits.' };
    }

    const resolvedPrice = resolveOutcomePrice(market.prices ?? {}, decision.outcome);
    const predictionId = createPrediction({
      marketId: market.id,
      marketTitle: market.question,
      predictedOutcome: decision.outcome,
      predictedProbability: resolvedPrice ?? 0,
      confidenceLevel: decision.confidence,
      reasoning: decision.reasoning,
    });

    try {
      const usdcAmount = ethers.utils.parseUnits(decision.amount.toFixed(6), 6);
      const allowance = await this.trader.allowance();
      if (allowance.lt(usdcAmount)) {
        await this.trader.approveUsdc(usdcAmount);
      }

      const outcomeIndex = decision.outcome === 'YES' ? 0 : 1;
      const price = resolvedPrice ?? 0.5;
      const expectedShares = usdcAmount.mul(ethers.utils.parseUnits('1', 6)).div(
        ethers.utils.parseUnits(price.toFixed(6), 6)
      );
      const minShares = expectedShares.mul(ethers.utils.parseUnits((1 - this.slippage).toFixed(6), 6)).div(
        ethers.utils.parseUnits('1', 6)
      );

      const tx = await this.trader.buy({
        marketFactory: market.augur.marketFactory,
        marketId: market.augur.marketIndex,
        outcome: outcomeIndex,
        collateralIn: usdcAmount.toString(),
        minShares: minShares.toString(),
      });

      recordExecution({
        id: predictionId,
        executionPrice: price,
        positionSize: decision.amount,
      });
      recordTrade({
        predictionId,
        marketId: market.id,
        marketTitle: market.question,
        outcome: decision.outcome,
        side: decision.action,
        price,
        amount: decision.amount,
      });
      logWalletOperation({
        operation: 'submit',
        amount: decision.amount,
        status: 'pending',
        transactionHash: tx.hash,
        metadata: { marketId: market.id, predictionId },
      });
      return { executed: true, message: `Trade submitted: ${tx.hash}` };
    } catch (error) {
      logWalletOperation({
        operation: 'reject',
        amount: decision.amount,
        status: 'failed',
        reason: error instanceof Error ? error.message : 'Unknown error',
        metadata: { marketId: market.id, predictionId },
      });
      return {
        executed: false,
        message: `Augur trade failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  async getOpenOrders(): Promise<Order[]> {
    return [];
  }

  async cancelOrder(_id: string): Promise<void> {
    throw new Error('Augur AMM trades execute immediately; no open orders to cancel.');
  }
}

function resolveOutcomePrice(
  prices: Record<string, number>,
  outcome: 'YES' | 'NO'
): number | null {
  if (outcome === 'YES') {
    return prices.YES ?? prices.Yes ?? prices.yes ?? null;
  }
  return prices.NO ?? prices.No ?? prices.no ?? null;
}
