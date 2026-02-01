import { openDatabase } from '../memory/db.js';
import { listOpenPositionsFromTrades } from '../memory/trades.js';
import { getMarketCache } from '../memory/market_cache.js';

export interface EvaluationSummary {
  windowDays?: number;
  totals: {
    predictions: number;
    executedPredictions: number;
    resolvedPredictions: number;
    accuracy: number | null;
    avgBrier: number | null;
    avgEdge: number | null;
    realizedPnl: number;
    unrealizedPnl: number;
    totalPnl: number;
    winRate: number | null;
  };
  byDomain: Array<{
    domain: string;
    predictions: number;
    executedPredictions: number;
    resolvedPredictions: number;
    accuracy: number | null;
    avgBrier: number | null;
    avgEdge: number | null;
    realizedPnl: number;
    unrealizedPnl: number;
    totalPnl: number;
  }>;
  process?: {
    decisions: number;
    criticApproved: number;
    criticRejected: number;
    avgFragility: number | null;
    withToolTrace: number;
  };
}

function resolveDomain(marketId: string, fallback?: string): string {
  const cached = getMarketCache(marketId);
  const category = cached?.category ?? fallback ?? 'unknown';
  return category || 'unknown';
}

function resolveCurrentPrice(params: {
  outcome: 'YES' | 'NO';
  currentPrices?: Record<string, number> | number[] | null;
  executionPrice?: number | null;
}): number {
  const { outcome, currentPrices, executionPrice } = params;
  let currentPrice: number | null = null;
  if (Array.isArray(currentPrices)) {
    currentPrice = outcome === 'YES' ? currentPrices[0] ?? null : currentPrices[1] ?? null;
  } else if (currentPrices) {
    currentPrice =
      currentPrices[outcome] ??
      currentPrices[outcome.toUpperCase()] ??
      currentPrices[outcome.toLowerCase()] ??
      currentPrices[outcome === 'YES' ? 'Yes' : 'No'] ??
      currentPrices[outcome === 'YES' ? 'yes' : 'no'] ??
      null;
  }
  return currentPrice ?? executionPrice ?? 0;
}

function windowClause(windowDays?: number): { clause: string; params: unknown[] } {
  if (!windowDays || windowDays <= 0) {
    return { clause: '', params: [] };
  }
  return {
    clause: "WHERE date(created_at) >= date('now', ?)",
    params: [`-${windowDays} days`],
  };
}

function outcomeWindowClause(windowDays?: number): { clause: string; params: unknown[] } {
  if (!windowDays || windowDays <= 0) {
    return { clause: '', params: [] };
  }
  return {
    clause: "WHERE date(COALESCE(outcome_timestamp, created_at)) >= date('now', ?)",
    params: [`-${windowDays} days`],
  };
}

export function getEvaluationSummary(options?: {
  windowDays?: number;
  domain?: string;
}): EvaluationSummary {
  const db = openDatabase();
  const windowDays = options?.windowDays;

  const predictionWindow = windowClause(windowDays);
  const outcomeWindow = outcomeWindowClause(windowDays);

  const predictionRows = db
    .prepare(
      `
        SELECT
          domain,
          executed,
          predicted_outcome as predictedOutcome,
          predicted_probability as predictedProbability,
          execution_price as executionPrice,
          outcome,
          brier_contribution as brier
        FROM predictions
        ${predictionWindow.clause}
      `
    )
    .all(...predictionWindow.params) as Array<Record<string, unknown>>;

  const outcomeRows = db
    .prepare(
      `
        SELECT
          domain,
          predicted_outcome as predictedOutcome,
          outcome,
          brier_contribution as brier
        FROM predictions
        ${outcomeWindow.clause ? `${outcomeWindow.clause} AND outcome IS NOT NULL` : 'WHERE outcome IS NOT NULL'}
      `
    )
    .all(...outcomeWindow.params) as Array<Record<string, unknown>>;

  const tradeWindow = windowClause(windowDays);
  const tradeRows = db
    .prepare(
      `
        SELECT
          market_id as marketId,
          amount,
          side
        FROM trades
        ${tradeWindow.clause}
      `
    )
    .all(...tradeWindow.params) as Array<Record<string, unknown>>;

  const domainFilter = options?.domain;

  const domainStats = new Map<string, {
    predictions: number;
    executedPredictions: number;
    resolvedPredictions: number;
    correct: number;
    brierSum: number;
    brierCount: number;
    edgeSum: number;
    edgeCount: number;
    realizedPnl: number;
    unrealizedPnl: number;
  }>();

  const totals = {
    predictions: 0,
    executedPredictions: 0,
    resolvedPredictions: 0,
    correct: 0,
    brierSum: 0,
    brierCount: 0,
    edgeSum: 0,
    edgeCount: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
  };

  for (const row of predictionRows) {
    const domain = (row.domain as string | null) ?? 'unknown';
    if (domainFilter && domain !== domainFilter) {
      continue;
    }

    const executed = Boolean(row.executed);
    const predictedProbability = row.predictedProbability as number | null;
    const executionPrice = row.executionPrice as number | null;

    const stats = domainStats.get(domain) ?? {
      predictions: 0,
      executedPredictions: 0,
      resolvedPredictions: 0,
      correct: 0,
      brierSum: 0,
      brierCount: 0,
      edgeSum: 0,
      edgeCount: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
    };

    stats.predictions += 1;
    totals.predictions += 1;
    if (executed) {
      stats.executedPredictions += 1;
      totals.executedPredictions += 1;
    }

    if (predictedProbability != null && executionPrice != null) {
      const edge = predictedProbability - executionPrice;
      stats.edgeSum += edge;
      stats.edgeCount += 1;
      totals.edgeSum += edge;
      totals.edgeCount += 1;
    }

    domainStats.set(domain, stats);
  }

  for (const row of outcomeRows) {
    const domain = (row.domain as string | null) ?? 'unknown';
    if (domainFilter && domain !== domainFilter) {
      continue;
    }

    const predictedOutcome = row.predictedOutcome as string | null;
    const outcome = row.outcome as string | null;
    const brier = row.brier as number | null;

    const stats = domainStats.get(domain) ?? {
      predictions: 0,
      executedPredictions: 0,
      resolvedPredictions: 0,
      correct: 0,
      brierSum: 0,
      brierCount: 0,
      edgeSum: 0,
      edgeCount: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
    };

    stats.resolvedPredictions += 1;
    totals.resolvedPredictions += 1;
    if (predictedOutcome && outcome && predictedOutcome === outcome) {
      stats.correct += 1;
      totals.correct += 1;
    }
    if (brier != null) {
      stats.brierSum += brier;
      stats.brierCount += 1;
      totals.brierSum += brier;
      totals.brierCount += 1;
    }

    domainStats.set(domain, stats);
  }

  for (const row of tradeRows) {
    const marketId = String(row.marketId);
    const domain = resolveDomain(marketId);
    if (domainFilter && domain !== domainFilter) {
      continue;
    }
    const amount = Number(row.amount ?? 0);
    const side = row.side as string | null;
    const pnl = side === 'sell' ? amount : -amount;

    const stats = domainStats.get(domain) ?? {
      predictions: 0,
      executedPredictions: 0,
      resolvedPredictions: 0,
      correct: 0,
      brierSum: 0,
      brierCount: 0,
      edgeSum: 0,
      edgeCount: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
    };

    stats.realizedPnl += pnl;
    totals.realizedPnl += pnl;
    domainStats.set(domain, stats);
  }

  const openPositions = listOpenPositionsFromTrades(500);
  for (const position of openPositions) {
    const domain = resolveDomain(position.marketId);
    if (domainFilter && domain !== domainFilter) {
      continue;
    }

    const price = resolveCurrentPrice({
      outcome: position.predictedOutcome ?? 'YES',
      currentPrices: position.currentPrices ?? null,
      executionPrice: position.executionPrice ?? null,
    });
    const netShares = Math.abs(position.netShares ?? 0);
    if (netShares <= 0 || price <= 0) {
      continue;
    }
    const marketValue = netShares * price;
    const unrealized = marketValue - (position.positionSize ?? 0);

    const stats = domainStats.get(domain) ?? {
      predictions: 0,
      executedPredictions: 0,
      resolvedPredictions: 0,
      correct: 0,
      brierSum: 0,
      brierCount: 0,
      edgeSum: 0,
      edgeCount: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
    };

    stats.unrealizedPnl += unrealized;
    totals.unrealizedPnl += unrealized;
    domainStats.set(domain, stats);
  }

  const byDomain = Array.from(domainStats.entries())
    .map(([domain, stats]) => ({
      domain,
      predictions: stats.predictions,
      executedPredictions: stats.executedPredictions,
      resolvedPredictions: stats.resolvedPredictions,
      accuracy:
        stats.resolvedPredictions > 0 ? stats.correct / stats.resolvedPredictions : null,
      avgBrier: stats.brierCount > 0 ? stats.brierSum / stats.brierCount : null,
      avgEdge: stats.edgeCount > 0 ? stats.edgeSum / stats.edgeCount : null,
      realizedPnl: stats.realizedPnl,
      unrealizedPnl: stats.unrealizedPnl,
      totalPnl: stats.realizedPnl + stats.unrealizedPnl,
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  const summary: EvaluationSummary = {
    windowDays,
    totals: {
      predictions: totals.predictions,
      executedPredictions: totals.executedPredictions,
      resolvedPredictions: totals.resolvedPredictions,
      accuracy: totals.resolvedPredictions > 0 ? totals.correct / totals.resolvedPredictions : null,
      avgBrier: totals.brierCount > 0 ? totals.brierSum / totals.brierCount : null,
      avgEdge: totals.edgeCount > 0 ? totals.edgeSum / totals.edgeCount : null,
      realizedPnl: totals.realizedPnl,
      unrealizedPnl: totals.unrealizedPnl,
      totalPnl: totals.realizedPnl + totals.unrealizedPnl,
      winRate: totals.resolvedPredictions > 0 ? totals.correct / totals.resolvedPredictions : null,
    },
    byDomain,
  };

  try {
    const decisionRows = db
      .prepare(
        `
          SELECT
            critic_approved as criticApproved,
            fragility_score as fragilityScore,
            tool_trace as toolTrace
          FROM decision_audit
          ${windowDays ? "WHERE date(created_at) >= date('now', ?)" : ''}
        `
      )
      .all(...(windowDays ? [`-${windowDays} days`] : [])) as Array<Record<string, unknown>>;

    if (decisionRows.length > 0) {
      let criticApproved = 0;
      let criticRejected = 0;
      let fragilitySum = 0;
      let fragilityCount = 0;
      let withToolTrace = 0;

      for (const row of decisionRows) {
        const approved = row.criticApproved as number | null;
        if (approved === 1) criticApproved += 1;
        if (approved === 0) criticRejected += 1;
        const fragility = row.fragilityScore as number | null;
        if (fragility != null) {
          fragilitySum += fragility;
          fragilityCount += 1;
        }
        if (row.toolTrace) {
          withToolTrace += 1;
        }
      }

      summary.process = {
        decisions: decisionRows.length,
        criticApproved,
        criticRejected,
        avgFragility: fragilityCount > 0 ? fragilitySum / fragilityCount : null,
        withToolTrace,
      };
    }
  } catch {
    // decision_audit table may not exist yet; ignore.
  }

  return summary;
}
