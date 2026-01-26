#!/usr/bin/env node
/**
 * Bijaz CLI
 *
 * Command-line interface for Bijaz prediction market companion.
 */

import { Command } from 'commander';
import { VERSION } from '../index.js';
import { loadConfig } from '../core/config.js';
import {
  createPrediction,
  getPrediction,
  listPredictions,
} from '../memory/predictions.js';
import { PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { addWatchlist, listWatchlist } from '../memory/watchlist.js';
import { runIntelPipeline } from '../intel/pipeline.js';
import { listRecentIntel } from '../intel/store.js';
import { rankIntelAlerts } from '../intel/alerts.js';
import { runProactiveSearch } from '../core/proactive_search.js';
import {
  listCalibrationSummaries,
  listResolvedPredictions,
} from '../memory/calibration.js';
import { listOpenPositions } from '../memory/predictions.js';
import { listOpenPositionsFromTrades } from '../memory/trades.js';
import { adjustCashBalance, getCashBalance, setCashBalance } from '../memory/portfolio.js';
import { resolveOutcomes } from '../core/resolver.js';
import { getUserContext, updateUserContext } from '../memory/user.js';
import { encryptPrivateKey, saveKeystore } from '../execution/wallet/keystore.js';
import { loadWallet } from '../execution/wallet/manager.js';
import { DbSpendingLimitEnforcer } from '../execution/wallet/limits_db.js';
import { ethers } from 'ethers';
import inquirer from 'inquirer';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'yaml';
import { openDatabase } from '../memory/db.js';
import { pruneChatMessages } from '../memory/chat.js';
import { SessionStore } from '../memory/session_store.js';

function getConfigPath(): string {
  return (
    process.env.BIJAZ_CONFIG_PATH ?? join(homedir(), '.bijaz', 'config.yaml')
  );
}

const program = new Command();
const config = loadConfig();
if (config.memory?.dbPath) {
  process.env.BIJAZ_DB_PATH = config.memory.dbPath;
}

program
  .name('bijaz')
  .description('Prediction Market AI Companion')
  .version(VERSION);

// ============================================================================
// Wallet Commands
// ============================================================================

const wallet = program.command('wallet').description('Wallet management');

wallet
  .command('create')
  .description('Create a new wallet')
  .action(async () => {
    const answers = await inquirer.prompt([
      { type: 'password', name: 'password', message: 'Set keystore password:' },
    ]);
    const wallet = ethers.Wallet.createRandom();
    const store = encryptPrivateKey(wallet.privateKey, answers.password, wallet.address);
    const path =
      config.wallet?.keystorePath ??
      process.env.BIJAZ_KEYSTORE_PATH ??
      `${process.env.HOME ?? ''}/.bijaz/keystore.json`;
    saveKeystore(path, store);
    console.log(`Wallet created: ${wallet.address}`);
  });

wallet
  .command('import')
  .description('Import an existing wallet')
  .action(async () => {
    const answers = await inquirer.prompt([
      { type: 'password', name: 'privateKey', message: 'Private key:' },
      { type: 'password', name: 'password', message: 'Set keystore password:' },
    ]);
    const wallet = new ethers.Wallet(answers.privateKey.trim());
    const store = encryptPrivateKey(wallet.privateKey, answers.password, wallet.address);
    const path =
      config.wallet?.keystorePath ??
      process.env.BIJAZ_KEYSTORE_PATH ??
      `${process.env.HOME ?? ''}/.bijaz/keystore.json`;
    saveKeystore(path, store);
    console.log(`Wallet imported: ${wallet.address}`);
  });

wallet
  .command('status')
  .description('Show wallet status and balance')
  .action(async () => {
    console.log('Wallet Status');
    console.log('─'.repeat(40));
    const answers = await inquirer.prompt([
      { type: 'password', name: 'password', message: 'Keystore password:' },
    ]);
    const wallet = loadWallet(config, answers.password);
    console.log(`Address: ${wallet.address}`);
    if (wallet.provider) {
      const balance = await wallet.provider.getBalance(wallet.address);
      console.log(`MATIC: ${ethers.utils.formatEther(balance)}`);
      const { getWalletBalances } = await import('../execution/wallet/balances.js');
      const tokenBalances = await getWalletBalances(wallet);
      if (tokenBalances) {
        console.log(`USDC: ${tokenBalances.usdc.toFixed(2)} (${tokenBalances.usdcAddress})`);
      }
    } else {
      console.log('No RPC provider configured.');
    }
  });

const walletLimits = wallet.command('limits').description('Spending limits');

walletLimits
  .command('show')
  .description('Show current spending limits')
  .action(async () => {
    console.log('Spending Limits');
    console.log('─'.repeat(40));
    const limits = config.wallet?.limits ?? { daily: 100, perTrade: 25, confirmationThreshold: 10 };
    const limiter = new DbSpendingLimitEnforcer({
      daily: limits.daily ?? 100,
      perTrade: limits.perTrade ?? 25,
      confirmationThreshold: limits.confirmationThreshold ?? 10,
    });
    const remaining = limiter.getRemainingDaily();

    let todaySpent = 0;
    let todayTradeCount = 0;
    try {
      const db = openDatabase();
      const row = db
        .prepare(
          `SELECT today_spent as todaySpent, today_trade_count as todayTradeCount
           FROM spending_state WHERE id = 1`
        )
        .get() as { todaySpent?: number; todayTradeCount?: number } | undefined;
      if (row) {
        todaySpent = row.todaySpent ?? 0;
        todayTradeCount = row.todayTradeCount ?? 0;
      }
    } catch {
      // Ignore if DB not available
    }

    console.log(`Daily limit: $${Number(limits.daily ?? 100).toFixed(2)}`);
    console.log(`Per-trade limit: $${Number(limits.perTrade ?? 25).toFixed(2)}`);
    console.log(
      `Confirmation threshold: $${Number(limits.confirmationThreshold ?? 10).toFixed(2)}`
    );
    console.log('');
    console.log(`Today spent: $${todaySpent.toFixed(2)} (${todayTradeCount} trades)`);
    console.log(`Remaining daily: $${remaining.toFixed(2)}`);
  });

walletLimits
  .command('set')
  .description('Set spending limits')
  .option('--daily <amount>', 'Daily spending limit (USD)')
  .option('--per-trade <amount>', 'Per-trade limit (USD)')
  .option('--confirmation-threshold <amount>', 'Confirmation threshold (USD)')
  .action(async (options) => {
    const daily = options.daily !== undefined ? Number(options.daily) : undefined;
    const perTrade = options.perTrade !== undefined ? Number(options.perTrade) : undefined;
    const confirmation =
      options.confirmationThreshold !== undefined
        ? Number(options.confirmationThreshold)
        : undefined;

    if (
      daily === undefined &&
      perTrade === undefined &&
      confirmation === undefined
    ) {
      console.log('No limits provided. Use --daily, --per-trade, or --confirmation-threshold.');
      return;
    }

    const invalid =
      (daily !== undefined && (!Number.isFinite(daily) || daily <= 0)) ||
      (perTrade !== undefined && (!Number.isFinite(perTrade) || perTrade <= 0)) ||
      (confirmation !== undefined &&
        (!Number.isFinite(confirmation) || confirmation <= 0));
    if (invalid) {
      console.log('All limit values must be positive numbers.');
      return;
    }

    const path = getConfigPath();
    if (!existsSync(path)) {
      console.log(`Config not found: ${path}`);
      return;
    }

    const raw = readFileSync(path, 'utf-8');
    const parsed = (yaml.parse(raw) ?? {}) as Record<string, unknown>;
    const wallet = (parsed.wallet ?? {}) as Record<string, unknown>;
    const limits = (wallet.limits ?? {}) as Record<string, unknown>;

    if (daily !== undefined) {
      limits.daily = daily;
    }
    if (perTrade !== undefined) {
      limits.perTrade = perTrade;
    }
    if (confirmation !== undefined) {
      limits.confirmationThreshold = confirmation;
    }

    wallet.limits = limits;
    parsed.wallet = wallet;

    writeFileSync(path, yaml.stringify(parsed));
    console.log('Limits updated in config.');
  });

// ============================================================================
// Market Commands
// ============================================================================

const markets = program.command('markets').description('Market data');
const marketClient = new PolymarketMarketClient(config);

markets
  .command('list')
  .description('List active markets')
  .option('-c, --category <category>', 'Filter by category')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    console.log('Active Markets');
    console.log('─'.repeat(60));
    const list = await marketClient.listMarkets(Number(options.limit));
    for (const market of list) {
      console.log(`${market.id} | ${market.question}`);
    }
  });

markets
  .command('show <id>')
  .description('Show market details')
  .action(async (id) => {
    console.log(`Market: ${id}`);
    console.log('─'.repeat(40));
    const market = await marketClient.getMarket(id);
    console.log(`Question: ${market.question}`);
    console.log(`Outcomes: ${market.outcomes.join(', ')}`);
    console.log(`Prices: ${JSON.stringify(market.prices)}`);
  });

markets
  .command('watch <id>')
  .description('Add market to watchlist')
  .action(async (id) => {
    console.log(`Adding ${id} to watchlist...`);
    addWatchlist(id);
    console.log('Done.');
  });

markets
  .command('sync')
  .description('Sync market cache for faster lookups')
  .option('-l, --limit <number>', 'Limit results', '200')
  .action(async (options) => {
    const { syncMarketCache } = await import('../core/markets_sync.js');
    const ora = await import('ora');
    const spinner = ora.default('Syncing market cache...').start();
    try {
      const result = await syncMarketCache(config, Number(options.limit));
      spinner.succeed(`Stored ${result.stored} market(s) in cache.`);
    } catch (error) {
      spinner.fail(
        `Market sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });

markets
  .command('watchlist')
  .description('List watched markets')
  .action(async () => {
    const watchlist = listWatchlist();
    if (watchlist.length === 0) {
      console.log('Watchlist is empty.');
      return;
    }
    console.log('Watchlist');
    console.log('─'.repeat(40));
    for (const item of watchlist) {
      console.log(item.marketId);
    }
  });

// ============================================================================
// Trade Commands
// ============================================================================

const trade = program.command('trade').description('Execute trades');

trade
  .command('buy <market> <outcome>')
  .description('Buy shares in a market')
  .requiredOption('-a, --amount <usd>', 'Amount in USD')
  .option('-p, --price <price>', 'Limit price (0-1)')
  .option('--dry-run', 'Simulate without executing')
  .action(async (market, outcome, options) => {
    const { PaperExecutor } = await import('../execution/modes/paper.js');
    const { WebhookExecutor } = await import('../execution/modes/webhook.js');
    const { DbSpendingLimitEnforcer } = await import('../execution/wallet/limits_db.js');

    const amount = Number(options.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      console.log('Amount must be a positive number.');
      return;
    }
    const price = options.price ? Number(options.price) : undefined;
    if (price !== undefined && (Number.isNaN(price) || price <= 0 || price > 1)) {
      console.log('Price must be a number between 0 and 1.');
      return;
    }

    const normalizedOutcome = String(outcome).toUpperCase();
    if (!['YES', 'NO'].includes(normalizedOutcome)) {
      console.log('Outcome must be YES or NO.');
      return;
    }

    const marketClient = new PolymarketMarketClient(config);
    const executor =
      config.execution.mode === 'webhook' && config.execution.webhookUrl
        ? new WebhookExecutor(config.execution.webhookUrl)
        : new PaperExecutor();
    const limiter = new DbSpendingLimitEnforcer({
      daily: config.wallet?.limits?.daily ?? 100,
      perTrade: config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
    });

    try {
      const marketData = await marketClient.getMarket(market);
      if (price !== undefined) {
        marketData.prices = { ...marketData.prices, [normalizedOutcome]: price };
      }

      const limitCheck = await limiter.checkAndReserve(amount);
      if (!limitCheck.allowed) {
        console.log(`Trade blocked: ${limitCheck.reason ?? 'limit exceeded'}`);
        return;
      }

      if (options.dryRun) {
        limiter.release(amount);
        console.log('Dry run: trade not executed.');
        return;
      }

      const result = await executor.execute(marketData, {
        action: 'buy',
        outcome: normalizedOutcome as 'YES' | 'NO',
        amount,
        confidence: 'medium',
        reasoning: 'Manual CLI trade',
      });

      if (result.executed) {
        limiter.confirm(amount);
      } else {
        limiter.release(amount);
      }
      console.log(result.message);
    } catch (error) {
      console.error('Trade failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

trade
  .command('sell <market> <outcome>')
  .description('Sell shares in a market')
  .requiredOption('-a, --amount <usd>', 'Amount in USD')
  .option('-p, --price <price>', 'Limit price (0-1)')
  .option('--dry-run', 'Simulate without executing')
  .action(async (market, outcome, options) => {
    const { PaperExecutor } = await import('../execution/modes/paper.js');
    const { WebhookExecutor } = await import('../execution/modes/webhook.js');
    const { DbSpendingLimitEnforcer } = await import('../execution/wallet/limits_db.js');

    const amount = Number(options.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      console.log('Amount must be a positive number.');
      return;
    }
    const price = options.price ? Number(options.price) : undefined;
    if (price !== undefined && (Number.isNaN(price) || price <= 0 || price > 1)) {
      console.log('Price must be a number between 0 and 1.');
      return;
    }

    const normalizedOutcome = String(outcome).toUpperCase();
    if (!['YES', 'NO'].includes(normalizedOutcome)) {
      console.log('Outcome must be YES or NO.');
      return;
    }

    const marketClient = new PolymarketMarketClient(config);
    const executor =
      config.execution.mode === 'webhook' && config.execution.webhookUrl
        ? new WebhookExecutor(config.execution.webhookUrl)
        : new PaperExecutor();
    const limiter = new DbSpendingLimitEnforcer({
      daily: config.wallet?.limits?.daily ?? 100,
      perTrade: config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
    });

    try {
      const marketData = await marketClient.getMarket(market);
      if (price !== undefined) {
        marketData.prices = { ...marketData.prices, [normalizedOutcome]: price };
      }

      const limitCheck = await limiter.checkAndReserve(amount);
      if (!limitCheck.allowed) {
        console.log(`Trade blocked: ${limitCheck.reason ?? 'limit exceeded'}`);
        return;
      }

      if (options.dryRun) {
        limiter.release(amount);
        console.log('Dry run: trade not executed.');
        return;
      }

      const result = await executor.execute(marketData, {
        action: 'sell',
        outcome: normalizedOutcome as 'YES' | 'NO',
        amount,
        confidence: 'medium',
        reasoning: 'Manual CLI trade',
      });

      if (result.executed) {
        limiter.confirm(amount);
      } else {
        limiter.release(amount);
      }
      console.log(result.message);
    } catch (error) {
      console.error('Trade failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

// ============================================================================
// Portfolio Commands
// ============================================================================

program
  .command('portfolio')
  .description('Show portfolio and positions')
  .option('--set-cash <amount>', 'Set cash balance (USD)')
  .option('--add-cash <amount>', 'Add to cash balance (USD)')
  .option('--withdraw-cash <amount>', 'Withdraw from cash balance (USD)')
  .action(async (options) => {
    const setCash = options.setCash !== undefined ? Number(options.setCash) : undefined;
    const addCash = options.addCash !== undefined ? Number(options.addCash) : undefined;
    const withdrawCash =
      options.withdrawCash !== undefined ? Number(options.withdrawCash) : undefined;

    if (setCash !== undefined || addCash !== undefined || withdrawCash !== undefined) {
      if (setCash !== undefined) {
        if (!Number.isFinite(setCash)) {
          console.log('Cash amount must be a number.');
          return;
        }
        setCashBalance(setCash);
      } else if (addCash !== undefined) {
        if (!Number.isFinite(addCash)) {
          console.log('Cash amount must be a number.');
          return;
        }
        adjustCashBalance(addCash);
      } else if (withdrawCash !== undefined) {
        if (!Number.isFinite(withdrawCash)) {
          console.log('Cash amount must be a number.');
          return;
        }
        adjustCashBalance(-withdrawCash);
      }

      const updated = getCashBalance();
      console.log(`Cash balance: $${updated.toFixed(2)}`);
      return;
    }

    console.log('Portfolio');
    console.log('═'.repeat(60));
    const positions = (() => {
      const fromTrades = listOpenPositionsFromTrades(200);
      return fromTrades.length > 0 ? fromTrades : listOpenPositions(200);
    })();
    const cashBalance = getCashBalance();
    if (positions.length === 0) {
      console.log('No open positions.');
      console.log(`Cash Balance: $${cashBalance.toFixed(2)}`);
      return;
    }

    let totalValue = 0;
    let totalCost = 0;

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
      const netShares =
        typeof (position as { netShares?: number | null }).netShares === 'number'
          ? Number((position as { netShares?: number | null }).netShares)
          : null;
      const shares =
        netShares !== null ? netShares : averagePrice > 0 ? positionSize / averagePrice : 0;
      const price = currentPrice ?? averagePrice;
      const value = shares * price;
      const unrealizedPnl = value - positionSize;
      const unrealizedPnlPercent =
        positionSize > 0 ? (unrealizedPnl / positionSize) * 100 : 0;

      totalValue += value;
      totalCost += positionSize;

      console.log(`${position.marketTitle}`);
      console.log(
        `  Outcome: ${outcome} | Shares: ${shares.toFixed(2)} | Avg: ${averagePrice.toFixed(4)} | Now: ${price.toFixed(4)}`
      );
      console.log(
        `  Value: $${value.toFixed(2)} | PnL: ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)} (${unrealizedPnlPercent.toFixed(1)}%)`
      );
      const realizedPnl =
        typeof (position as { realizedPnl?: number | null }).realizedPnl === 'number'
          ? Number((position as { realizedPnl?: number | null }).realizedPnl)
          : null;
      if (realizedPnl !== null) {
        console.log(`  Realized: ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`);
      }
      console.log(`  Market ID: ${position.marketId}`);
      console.log('');
    }

    const totalPnl = totalValue - totalCost;
    const totalPnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    const totalEquity = cashBalance + totalValue;

    console.log('Totals');
    console.log('─'.repeat(60));
    console.log(`Total Value: $${totalValue.toFixed(2)}`);
    console.log(`Total Cost: $${totalCost.toFixed(2)}`);
    console.log(`Total PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${totalPnlPercent.toFixed(1)}%)`);
    console.log(`Cash Balance: $${cashBalance.toFixed(2)}`);
    console.log(`Total Equity: $${totalEquity.toFixed(2)}`);
  });

// ============================================================================
// Prediction Commands
// ============================================================================

const predictions = program.command('predictions').description('Prediction tracking');

predictions
  .command('add')
  .description('Record a new prediction')
  .requiredOption('--market-id <id>', 'Market ID')
  .requiredOption('--title <title>', 'Market title')
  .option('--outcome <YES|NO>', 'Predicted outcome (YES/NO)')
  .option('--prob <number>', 'Predicted probability (0-1)')
  .option('--confidence <low|medium|high>', 'Confidence level')
  .option('--domain <domain>', 'Prediction domain/category')
  .option('--reasoning <text>', 'Short reasoning summary')
  .action(async (options) => {
    if (options.outcome && !['YES', 'NO'].includes(options.outcome)) {
      console.log('Outcome must be YES or NO.');
      return;
    }

    const probability = options.prob ? Number(options.prob) : undefined;
    if (probability !== undefined && (probability < 0 || probability > 1)) {
      console.log('Probability must be between 0 and 1.');
      return;
    }

    const id = createPrediction({
      marketId: options.marketId,
      marketTitle: options.title,
      predictedOutcome: options.outcome,
      predictedProbability: probability,
      confidenceLevel: options.confidence,
      domain: options.domain,
      reasoning: options.reasoning,
    });

    console.log(`Recorded prediction ${id}`);
  });

predictions
  .command('list')
  .description('List recent predictions')
  .option('-d, --domain <domain>', 'Filter by domain')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    const records = listPredictions({
      domain: options.domain,
      limit: Number(options.limit),
    });

    console.log('Recent Predictions');
    console.log('─'.repeat(80));
    for (const record of records) {
      const outcome = record.predictedOutcome ?? '-';
      const prob =
        record.predictedProbability !== undefined
          ? record.predictedProbability.toFixed(2)
          : '-';
      const domain = record.domain ?? '-';
      console.log(
        `${record.id} | ${outcome} | p=${prob} | ${domain} | ${record.marketTitle}`
      );
    }
  });

predictions
  .command('show <id>')
  .description('Show prediction details')
  .action(async (id) => {
    const record = getPrediction(id);
    if (!record) {
      console.log(`Prediction not found: ${id}`);
      return;
    }

    console.log(`Prediction: ${record.id}`);
    console.log('─'.repeat(60));
    console.log(`Market: ${record.marketTitle}`);
    console.log(`Outcome: ${record.predictedOutcome ?? '-'}`);
    console.log(
      `Probability: ${
        record.predictedProbability !== undefined
          ? record.predictedProbability.toFixed(2)
          : '-'
      }`
    );
    console.log(`Confidence: ${record.confidenceLevel ?? '-'}`);
    console.log(`Domain: ${record.domain ?? '-'}`);
    console.log(`Created: ${record.createdAt}`);
    if (record.reasoning) {
      console.log(`Reasoning: ${record.reasoning}`);
    }
  });

predictions
  .command('resolve')
  .description('Resolve outcomes for recent predictions')
  .option('-l, --limit <number>', 'Limit predictions checked', '25')
  .action(async (options) => {
    const updated = await resolveOutcomes(config, Number(options.limit));
    console.log(`Resolved ${updated} prediction(s).`);
  });

// ============================================================================
// Calibration Commands
// ============================================================================

const calibration = program.command('calibration').description('Calibration stats');

calibration
  .command('show')
  .description('Show calibration statistics')
  .option('-d, --domain <domain>', 'Filter by domain')
  .action(async (options) => {
    console.log('Calibration Report');
    console.log('═'.repeat(60));
    const summaries = listCalibrationSummaries();
    for (const summary of summaries) {
      if (options.domain && summary.domain !== options.domain) {
        continue;
      }
      const accuracy =
        summary.accuracy === null ? '-' : `${(summary.accuracy * 100).toFixed(1)}%`;
      const brier =
        summary.avgBrier === null ? '-' : summary.avgBrier.toFixed(4);
      console.log(
        `${summary.domain} | total=${summary.totalPredictions} | resolved=${summary.resolvedPredictions} | acc=${accuracy} | brier=${brier}`
      );
    }
  });

calibration
  .command('history')
  .description('Show prediction outcome history')
  .option('-d, --domain <domain>', 'Filter by domain')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    console.log('Prediction History');
    console.log('─'.repeat(60));
    const history = listResolvedPredictions(Number(options.limit));
    for (const item of history) {
      if (options.domain && item.domain !== options.domain) {
        continue;
      }
      const prob =
        item.predictedProbability === undefined
          ? '-'
          : item.predictedProbability.toFixed(2);
      const brier = item.brier === undefined ? '-' : item.brier.toFixed(4);
      console.log(
        `${item.outcomeTimestamp ?? ''} | ${item.marketTitle} | pred=${item.predictedOutcome ?? '-'} p=${prob} | outcome=${item.outcome ?? '-'} | brier=${brier}`
      );
    }
  });

// ============================================================================
// Intel Commands
// ============================================================================

const intel = program.command('intel').description('Intelligence sources');

intel
  .command('status')
  .description('Show intel source status')
  .action(async () => {
    console.log('Intel Sources');
    console.log('─'.repeat(60));
    const sources = config.intel?.sources ?? {};
    const entries = Object.entries(sources).map(([name, cfg]) => {
      const enabled = (cfg as { enabled?: boolean })?.enabled ? 'enabled' : 'disabled';
      return `${name}: ${enabled}`;
    });
    for (const line of entries) {
      console.log(line);
    }
    const embed = config.intel?.embeddings?.enabled ? 'enabled' : 'disabled';
    console.log(`embeddings: ${embed}`);
  });

intel
  .command('search <query>')
  .description('Search intel')
  .option('-l, --limit <number>', 'Limit results', '10')
  .option('--from <days>', 'Days back to search', '7')
  .action(async (query, options) => {
    const { searchIntel } = await import('../intel/store.js');
    const items = searchIntel({
      query,
      limit: Number(options.limit),
      fromDays: Number(options.from),
    });
    if (items.length === 0) {
      console.log('No results.');
      return;
    }
    for (const item of items) {
      console.log(`${item.timestamp} | ${item.title}`);
    }
  });

intel
  .command('recent')
  .description('Show recent intel')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    console.log('Recent Intel');
    console.log('─'.repeat(60));
    const items = listRecentIntel(Number(options.limit));
    for (const item of items) {
      console.log(`${item.timestamp} | ${item.title}`);
    }
  });

intel
  .command('alerts')
  .description('Preview intel alerts with current config')
  .option('-l, --limit <number>', 'Limit items scanned', '50')
  .option('--show-score', 'Show alert scores')
  .option('--show-reasons', 'Show alert reasons')
  .option('--min-score <number>', 'Minimum score threshold')
  .option('--sentiment <preset>', 'Sentiment preset: any|positive|negative|neutral')
  .action(async (options) => {
    const alertsConfig = config.notifications?.intelAlerts;
    if (!alertsConfig?.enabled) {
      console.log('Intel alerts are disabled in config.');
      return;
    }

    const previewConfig = { ...alertsConfig };
    if (options.showScore) {
      previewConfig.showScore = true;
    }
    if (options.showReasons) {
      previewConfig.showReasons = true;
    }
    if (options.minScore !== undefined) {
      const minScore = Number(options.minScore);
      if (!Number.isNaN(minScore)) {
        previewConfig.minScore = minScore;
      }
    }
    if (options.sentiment) {
      previewConfig.sentimentPreset = String(options.sentiment) as 'any' | 'positive' | 'negative' | 'neutral';
    }

    const limit = Number(options.limit);
    const items = listRecentIntel(Number.isNaN(limit) ? 50 : limit);
    if (items.length === 0) {
      console.log('No intel items to preview.');
      return;
    }

    let watchlistTitles: string[] = [];
    if (alertsConfig.watchlistOnly) {
      const markets = new PolymarketMarketClient(config);
      const watchlist = listWatchlist(50);
      for (const item of watchlist) {
        try {
          const market = await markets.getMarket(item.marketId);
          if (market.question) {
            watchlistTitles.push(market.question);
          }
        } catch {
          continue;
        }
      }
    }

    const alerts = rankIntelAlerts(
      items.map((item) => ({
        title: item.title,
        source: item.source,
        url: item.url,
        content: item.content,
      })),
      previewConfig,
      watchlistTitles
    ).map((item) => item.text);

    if (alerts.length === 0) {
      console.log('No alerts matched current config.');
      return;
    }
    console.log('Intel Alerts Preview');
    console.log('─'.repeat(60));
    for (const alert of alerts) {
      console.log(alert);
    }
  });

intel
  .command('fetch')
  .description('Fetch RSS intel now')
  .action(async () => {
    const stored = await runIntelPipeline(config);
    console.log(`Intel updated. New items stored: ${stored}.`);
  });

intel
  .command('proactive')
  .description('Run proactive search (Clawdbot-style)')
  .option('--max-queries <number>', 'Max search queries', '8')
  .option('--watchlist-limit <number>', 'Watchlist markets to scan', '20')
  .option('--recent-intel-limit <number>', 'Recent intel items to seed queries', '25')
  .option('--no-llm', 'Disable LLM query refinement')
  .option('--extra <query...>', 'Extra queries to include')
  .action(async (options) => {
    const result = await runProactiveSearch(config, {
      maxQueries: Number(options.maxQueries),
      watchlistLimit: Number(options.watchlistLimit),
      useLlm: options.llm !== false,
      recentIntelLimit: Number(options.recentIntelLimit),
      extraQueries: Array.isArray(options.extra) ? options.extra : [],
    });
    console.log(`Queries: ${result.queries.join(' | ')}`);
    console.log(`Stored items: ${result.storedCount}`);
  });

// ============================================================================
// Agent Commands
// ============================================================================

program
  .command('chat')
  .description('Interactive chat with Bijaz')
  .action(async () => {
    const { createLlmClient } = await import('../core/llm.js');
    const { ConversationHandler } = await import('../core/conversation.js');
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const readline = await import('node:readline');

    console.log('Starting Bijaz chat...');
    console.log('Ask me about future events, prediction markets, or anything you want to forecast.');
    console.log('Type "exit" or "quit" to end the conversation.\n');

    const llm = createLlmClient(config);
    const marketClient = new PolymarketMarketClient(config);
    const conversation = new ConversationHandler(llm, marketClient, config);
    const userId = 'cli-user';

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      rl.question('\nYou: ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed) {
          prompt();
          return;
        }
        if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
          console.log('\nGoodbye!');
          rl.close();
          return;
        }
        if (trimmed === '/clear') {
          conversation.clearHistory(userId);
          console.log('\nBijaz: Conversation cleared.');
          prompt();
          return;
        }

        try {
          console.log('\nBijaz: Thinking...');
          const response = await conversation.chat(userId, trimmed);
          console.log(`\nBijaz: ${response}`);
        } catch (error) {
          console.error('\nError:', error instanceof Error ? error.message : 'Unknown error');
        }
        prompt();
      });
    };

    prompt();
  });

program
  .command('analyze <market>')
  .description('Deep analysis of a market')
  .action(async (market) => {
    const { createLlmClient } = await import('../core/llm.js');
    const { ConversationHandler } = await import('../core/conversation.js');
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const ora = await import('ora');

    console.log(`Analyzing market: ${market}`);
    console.log('─'.repeat(60));

    const spinner = ora.default('Fetching market data and analyzing...').start();

    try {
      const llm = createLlmClient(config);
      const markets = new PolymarketMarketClient(config);
      const conversation = new ConversationHandler(llm, markets, config);

      const analysis = await conversation.analyzeMarket('cli-user', market);
      spinner.stop();
      console.log(analysis);
    } catch (error) {
      spinner.stop();
      console.error('Analysis failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

program
  .command('briefing')
  .description('Generate daily briefing')
  .action(async () => {
    console.log('Daily Briefing');
    console.log('═'.repeat(60));
    const { buildBriefing } = await import('../core/briefing.js');
    console.log(buildBriefing(10));
  });

program
  .command('ask <topic...>')
  .description('Ask about a topic and find relevant markets')
  .action(async (topicParts) => {
    const { createLlmClient } = await import('../core/llm.js');
    const { ConversationHandler } = await import('../core/conversation.js');
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const ora = await import('ora');

    const topic = topicParts.join(' ');
    console.log(`Researching: ${topic}`);
    console.log('─'.repeat(60));

    const spinner = ora.default('Searching markets and analyzing...').start();

    try {
      const llm = createLlmClient(config);
      const markets = new PolymarketMarketClient(config);
      const conversation = new ConversationHandler(llm, markets, config);

      const response = await conversation.askAbout('cli-user', topic);
      spinner.stop();
      console.log(response);
    } catch (error) {
      spinner.stop();
      console.error('Failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

// ============================================================================
// Autonomous Mode Commands
// ============================================================================

program
  .command('top10')
  .alias('opportunities')
  .description('Get today\'s top 10 trading opportunities')
  .action(async () => {
    const { createLlmClient } = await import('../core/llm.js');
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const { generateDailyReport, formatDailyReport } = await import('../core/opportunities.js');
    const ora = await import('ora');

    const spinner = ora.default('Scanning markets and analyzing opportunities...').start();

    try {
      const llm = createLlmClient(config);
      const markets = new PolymarketMarketClient(config);

      const report = await generateDailyReport(llm, markets, config);
      spinner.stop();
      console.log(formatDailyReport(report));
    } catch (error) {
      spinner.stop();
      console.error('Failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

const auto = program.command('auto').description('Autonomous trading controls');

auto
  .command('status')
  .description('Show autonomous mode status')
  .action(async () => {
    const { createLlmClient } = await import('../core/llm.js');
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const { PaperExecutor } = await import('../execution/modes/paper.js');
    const { DbSpendingLimitEnforcer } = await import('../execution/wallet/limits_db.js');
    const { AutonomousManager } = await import('../core/autonomous.js');

    const llm = createLlmClient(config);
    const markets = new PolymarketMarketClient(config);
    const executor = new PaperExecutor();
    const limiter = new DbSpendingLimitEnforcer({
      daily: config.wallet?.limits?.daily ?? 100,
      perTrade: config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
    });

    const autonomous = new AutonomousManager(llm, markets, executor, limiter, config);
    const status = autonomous.getStatus();
    const pnl = autonomous.getDailyPnL();

    console.log('Autonomous Mode Status');
    console.log('═'.repeat(40));
    console.log(`Enabled: ${status.enabled ? 'YES' : 'NO'}`);
    console.log(`Full Auto: ${status.fullAuto ? 'ON' : 'OFF'}`);
    console.log(`Paused: ${status.isPaused ? `YES (${status.pauseReason})` : 'NO'}`);
    console.log(`Consecutive losses: ${status.consecutiveLosses}`);
    console.log(`Remaining daily budget: $${status.remainingDaily.toFixed(2)}`);
    console.log('');
    console.log('Today\'s Activity');
    console.log('─'.repeat(40));
    console.log(`Trades: ${pnl.tradesExecuted} (W:${pnl.wins} L:${pnl.losses} P:${pnl.pending})`);
    console.log(`Realized P&L: ${pnl.realizedPnl >= 0 ? '+' : ''}$${pnl.realizedPnl.toFixed(2)}`);
  });

auto
  .command('on')
  .description('Enable full autonomous mode')
  .action(async () => {
    console.log('To enable full auto mode, set autonomy.fullAuto: true in your config.');
    console.log('Or use the /fullauto on command when running the gateway.');
    console.log('');
    console.log('Config path: ~/.bijaz/config.yaml');
  });

auto
  .command('off')
  .description('Disable full autonomous mode')
  .action(async () => {
    console.log('To disable full auto mode, set autonomy.fullAuto: false in your config.');
    console.log('Or use the /fullauto off command when running the gateway.');
  });

auto
  .command('report')
  .description('Generate full daily report')
  .action(async () => {
    const { createLlmClient } = await import('../core/llm.js');
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const { PaperExecutor } = await import('../execution/modes/paper.js');
    const { DbSpendingLimitEnforcer } = await import('../execution/wallet/limits_db.js');
    const { AutonomousManager } = await import('../core/autonomous.js');
    const ora = await import('ora');

    const spinner = ora.default('Generating daily report...').start();

    try {
      const llm = createLlmClient(config);
      const markets = new PolymarketMarketClient(config);
      const executor = new PaperExecutor();
      const limiter = new DbSpendingLimitEnforcer({
        daily: config.wallet?.limits?.daily ?? 100,
        perTrade: config.wallet?.limits?.perTrade ?? 25,
        confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
      });

      const autonomous = new AutonomousManager(llm, markets, executor, limiter, config);
      const report = await autonomous.generateDailyPnLReport();
      spinner.stop();
      console.log(report);
    } catch (error) {
      spinner.stop();
      console.error('Failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

// ============================================================================
// User Commands
// ============================================================================

const user = program.command('user').description('User profile memory');

user
  .command('show <id>')
  .description('Show user profile')
  .action(async (id) => {
    const profile = getUserContext(id);
    if (!profile) {
      console.log('No profile found.');
      return;
    }
    console.log(JSON.stringify(profile, null, 2));
  });

user
  .command('set <id>')
  .description('Update user profile')
  .option('--domains <list>', 'Comma-separated domains')
  .option('--risk <level>', 'conservative|moderate|aggressive')
  .option('--pref <key=value>', 'Preference key=value', (value, prev) => {
    const list = Array.isArray(prev) ? prev : [];
    return [...list, value];
  })
  .action(async (id, options) => {
    const prefs: Record<string, string> = {};
    for (const entry of options.pref ?? []) {
      const [key, value] = String(entry).split('=');
      if (key && value !== undefined) {
        prefs[key] = value;
      }
    }
    updateUserContext(id, {
      domainsOfInterest: options.domains
        ? String(options.domains)
            .split(',')
            .map((item) => item.trim())
        : undefined,
      riskTolerance: options.risk,
      preferences: Object.keys(prefs).length > 0 ? prefs : undefined,
    });
    console.log('Profile updated.');
  });

// ============================================================================
// Gateway Commands
// ============================================================================

program
  .command('gateway')
  .description('Start the Bijaz gateway')
  .option('-p, --port <port>', 'Port to listen on', '18789')
  .option('-v, --verbose', 'Verbose logging')
  .action(async (options) => {
    if (options.port) {
      process.env.BIJAZ_GATEWAY_PORT = String(options.port);
    }
    if (options.verbose) {
      process.env.BIJAZ_LOG_LEVEL = 'debug';
    }

    const { spawn } = await import('node:child_process');

    const args = ['src/gateway/index.ts'];
    const child = spawn('tsx', args, {
      stdio: 'inherit',
      env: { ...process.env },
    });

    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  });

// ============================================================================
// Memory Commands
// ============================================================================

const memory = program.command('memory').description('Persistent chat memory');

memory
  .command('sessions')
  .description('List known sessions')
  .action(async () => {
    const store = new SessionStore(config);
    const sessions = store.listSessions();
    if (sessions.length === 0) {
      console.log('No sessions found.');
      return;
    }
    console.log('Sessions');
    console.log('─'.repeat(60));
    for (const session of sessions) {
      console.log(`${session.userId} | ${session.sessionId} | last: ${session.lastActive}`);
    }
  });

memory
  .command('show <userId>')
  .description('Show transcript entries for a user')
  .option('-l, --limit <number>', 'Limit entries', '50')
  .action(async (userId, options) => {
    const store = new SessionStore(config);
    const entries = store.listEntries(userId);
    const limit = Number(options.limit);
    const slice = entries.slice(-Math.max(1, limit));
    if (slice.length === 0) {
      console.log('No transcript entries.');
      return;
    }
    for (const entry of slice) {
      const label =
        entry.type === 'summary' ? 'summary' : entry.role ?? 'message';
      console.log(`[${entry.timestamp}] ${label}: ${entry.content}`);
    }
  });

memory
  .command('compact <userId>')
  .description('Force compaction for a user session')
  .action(async (userId) => {
    const { createLlmClient } = await import('../core/llm.js');
    const llm = createLlmClient(config);
    const store = new SessionStore(config);
    await store.compactIfNeeded({
      userId,
      llm,
      maxMessages: config.memory?.maxHistoryMessages ?? 50,
      compactAfterTokens: 1,
      keepRecent: config.memory?.keepRecentMessages ?? 12,
    });
    console.log('Compaction complete.');
  });

memory
  .command('prune')
  .description('Prune old chat messages')
  .option('-d, --days <number>', 'Retention days', '90')
  .action(async (options) => {
    const days = Number(options.days);
    if (Number.isNaN(days) || days <= 0) {
      console.log('Days must be a positive number.');
      return;
    }
    const pruned = pruneChatMessages(days);
    console.log(`Pruned ${pruned} chat message(s).`);
  });

// ============================================================================
// Parse and Run
// ============================================================================

program.parse();
