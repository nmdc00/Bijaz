import type { ToolResult } from './tool-executor.js';
import { listIntelByIds, type StoredIntel } from '../intel/store.js';
import { extractEventsFromIntel } from '../events/extract.js';
import { ensureForecastsForThought, ensureThoughtForEvent } from '../events/thoughts.js';
import { buildMarketContextPlan } from '../markets/context.js';
import { collectForecastMarketSnapshot, sweepExpiredForecasts } from '../events/outcomes.js';
import { createMarketClient } from '../execution/market-client.js';
import type { ThufirConfig } from './config.js';

export type ProactiveIntentMode = 'off' | 'time_sensitive' | 'always';

export interface ProactiveRefreshSettings {
  enabled: boolean;
  intentMode: ProactiveIntentMode;
  ttlSeconds: number;
  maxLatencyMs: number;
  marketLimit: number;
  intelLimit: number;
  webLimit: number;
  strictFailClosed: boolean;
  fundingSymbols: string[];
}

export interface ProactiveRefreshSnapshot {
  asOf: string;
  query: string;
  domain: string;
  sources: string[];
  data: {
    currentTime?: unknown;
    markets?: unknown;
    marketContext?: unknown;
    marketSnapshots?: unknown;
    intel?: unknown;
    web?: unknown;
    fundingOISkew?: Array<{ symbol: string; signal: unknown }>;
    events?: unknown;
    extractionGaps?: unknown;
  };
}

export interface CachedProactiveSnapshot {
  ts: number;
  snapshot: ProactiveRefreshSnapshot;
}

export interface ProactiveRefreshOutcome {
  triggered: boolean;
  fromCache: boolean;
  failClosed: boolean;
  failReason?: string;
  snapshot?: ProactiveRefreshSnapshot;
  contextText: string;
}

type ExecuteToolFn = (toolName: string, input: Record<string, unknown>) => Promise<ToolResult>;

type ToolCallOutcome = {
  source: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

const TIME_SENSITIVE_PATTERN =
  /\b(latest|today|yesterday|this\s+(week|month|year)|right now|currently|bull|bear|risk[- ]?on|risk[- ]?off|macro|regime|outlook|headline|news|war|iran|hormuz|opec|oil|gold|commodity)\b/i;

function toSafeJson(value: unknown, maxChars = 1500): string {
  const raw = JSON.stringify(value, null, 2);
  if (!raw) return '';
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n... [truncated]`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function runTool(
  executeTool: ExecuteToolFn,
  toolName: string,
  input: Record<string, unknown>,
  latencyMs: number,
  sourceLabel?: string
): Promise<ToolCallOutcome> {
  try {
    const result = await withTimeout(executeTool(toolName, input), latencyMs, toolName);
    if (result.success) {
      return { source: sourceLabel ?? toolName, success: true, data: result.data };
    }
    return {
      source: sourceLabel ?? toolName,
      success: false,
      error: (result as { error?: string }).error ?? `${toolName} failed`,
    };
  } catch (error) {
    return {
      source: sourceLabel ?? toolName,
      success: false,
      error: error instanceof Error ? error.message : `${toolName} failed`,
    };
  }
}

function buildContextFromSnapshot(snapshot: ProactiveRefreshSnapshot): string {
  const lines: string[] = [
    '## Proactive Fresh Snapshot',
    `as_of: ${snapshot.asOf}`,
    `domain: ${snapshot.domain}`,
    `sources: ${snapshot.sources.join(', ')}`,
  ];

  if (snapshot.data.currentTime !== undefined) {
    lines.push(`### current_time\n${toSafeJson(snapshot.data.currentTime)}`);
  }
  if (snapshot.data.markets !== undefined) {
    lines.push(`### perp_market_list\n${toSafeJson(snapshot.data.markets)}`);
  }
  if (snapshot.data.marketContext !== undefined) {
    lines.push(`### market_context\n${toSafeJson(snapshot.data.marketContext)}`);
  }
  if (snapshot.data.marketSnapshots !== undefined) {
    lines.push(`### market_snapshots\n${toSafeJson(snapshot.data.marketSnapshots)}`);
  }
  if (snapshot.data.fundingOISkew && snapshot.data.fundingOISkew.length > 0) {
    lines.push(`### signal_hyperliquid_funding_oi_skew\n${toSafeJson(snapshot.data.fundingOISkew)}`);
  }
  if (snapshot.data.intel !== undefined) {
    lines.push(`### intel_search\n${toSafeJson(snapshot.data.intel)}`);
  }
  if (snapshot.data.web !== undefined) {
    lines.push(`### web_search\n${toSafeJson(snapshot.data.web)}`);
  }
  if (snapshot.data.events !== undefined) {
    lines.push(`### events\n${toSafeJson(snapshot.data.events)}`);
  }
  if (snapshot.data.extractionGaps !== undefined) {
    lines.push(`### extraction_gaps\n${toSafeJson(snapshot.data.extractionGaps)}`);
  }

  return `${lines.join('\n\n')}\n`;
}

export function isTimeSensitivePrompt(message: string): boolean {
  return TIME_SENSITIVE_PATTERN.test(message);
}

export function shouldTriggerProactiveRefresh(
  message: string,
  settings: ProactiveRefreshSettings
): boolean {
  if (!settings.enabled || settings.intentMode === 'off') return false;
  if (settings.intentMode === 'always') return true;
  return isTimeSensitivePrompt(message);
}

export function buildFailClosedMessage(reason: string): string {
  return [
    'I need a fresh market/news refresh before answering that confidently.',
    `Reason: ${reason}`,
    'Please retry in a moment.',
  ].join(' ');
}

export function appendProactiveAttribution(
  response: string,
  snapshot: ProactiveRefreshSnapshot | null
): string {
  if (!snapshot) return response;
  const hasAsOf = /\bas_of\s*:/i.test(response) || /\bas[- ]of\s*:/i.test(response);
  const hasSources = /\bsources?\s*:/i.test(response);
  if (hasAsOf && hasSources) return response;
  const footer = [`as_of: ${snapshot.asOf}`, `sources: ${snapshot.sources.join(', ')}`].join('\n');
  return `${response}\n\n${footer}`;
}

export async function runProactiveRefresh(params: {
  message: string;
  settings: ProactiveRefreshSettings;
  cached?: CachedProactiveSnapshot | null;
  executeTool: ExecuteToolFn;
  config?: ThufirConfig;
}): Promise<ProactiveRefreshOutcome> {
  const { message, settings, cached, executeTool, config } = params;
  const shouldRun = shouldTriggerProactiveRefresh(message, settings);
  if (!shouldRun) {
    return { triggered: false, fromCache: false, failClosed: false, contextText: '' };
  }

  const ttlMs = Math.max(0, settings.ttlSeconds) * 1000;
  const now = Date.now();
  if (cached && now - cached.ts <= ttlMs) {
    return {
      triggered: true,
      fromCache: true,
      failClosed: false,
      snapshot: cached.snapshot,
      contextText: buildContextFromSnapshot(cached.snapshot),
    };
  }

  const contextPlan = buildMarketContextPlan(message);
  const fundingSymbols = contextPlan.includeFundingSignals ? settings.fundingSymbols.slice(0, 3) : [];
  const marketPromise = runTool(
    executeTool,
    'perp_market_list',
    { limit: Math.max(1, contextPlan.requiresDomainSpecificRetrieval ? 200 : settings.marketLimit) },
    settings.maxLatencyMs
  );
  const timePromise = runTool(executeTool, 'current_time', {}, settings.maxLatencyMs);
  const intelPromises = contextPlan.searchQueries.slice(0, 3).map((query) =>
    runTool(
      executeTool,
      'intel_search',
      { query, limit: Math.max(1, settings.intelLimit) },
      settings.maxLatencyMs,
      `intel_search:${query}`
    )
  );
  const webPromises = contextPlan.searchQueries.slice(0, 3).map((query) =>
    runTool(
      executeTool,
      'web_search',
      { query, limit: Math.max(1, settings.webLimit) },
      settings.maxLatencyMs,
      `web_search:${query}`
    )
  );
  const fundingPromises = fundingSymbols.map((symbol) =>
    runTool(
      executeTool,
      'signal_hyperliquid_funding_oi_skew',
      { symbol },
      settings.maxLatencyMs,
      `signal_hyperliquid_funding_oi_skew:${symbol}`
    )
  );

  const [market, time, ...rest] = await Promise.all([
    marketPromise,
    timePromise,
    ...intelPromises,
    ...webPromises,
    ...fundingPromises,
  ]);
  const intelResults = rest.slice(0, intelPromises.length);
  const webResults = rest.slice(intelPromises.length, intelPromises.length + webPromises.length);
  const fundingResults = rest.slice(intelPromises.length + webPromises.length);

  const hasMarket = market.success;
  const hasNews = intelResults.some((result) => result.success) || webResults.some((result) => result.success);
  const hasTiming = time.success;
  const hasSignal = fundingResults.some((result) => result.success);
  const sufficientEvidence = contextPlan.requiresDomainSpecificRetrieval
    ? hasNews && hasMarket
    : hasMarket && (hasNews || hasSignal || hasTiming);

  if (!sufficientEvidence && settings.strictFailClosed) {
    const reasons = [market, time, ...intelResults, ...webResults, ...fundingResults]
      .filter((item) => !item.success)
      .map((item) => `${item.source}: ${item.error ?? 'failed'}`)
      .slice(0, 4)
      .join(' | ');
    return {
      triggered: true,
      fromCache: false,
      failClosed: true,
      failReason: reasons || contextPlan.retrievalGapMessage,
      contextText: '',
    };
  }

  const fundingSignals = fundingResults
    .filter((result) => result.success)
    .map((result) => {
      const symbol = result.source.split(':')[1] ?? 'unknown';
      return { symbol, signal: result.data };
    });

  const intelItems: StoredIntel[] = [];
  for (const result of intelResults.filter((entry) => entry.success)) {
    const rows = Array.isArray(result.data) ? result.data as Array<Record<string, unknown>> : [];
    const ids = rows.map((row) => String(row.id ?? '')).filter(Boolean);
    intelItems.push(...listIntelByIds(ids));
  }
  for (const result of webResults.filter((entry) => entry.success)) {
    const data = result.data as { results?: Array<Record<string, unknown>> } | undefined;
    for (const row of data?.results ?? []) {
      const title = typeof row.title === 'string' ? row.title : '';
      const snippet = typeof row.snippet === 'string' ? row.snippet : '';
      if (!title && !snippet) continue;
      intelItems.push({
        id: `web:${title}:${row.url ?? ''}`,
        title: title || String(row.url ?? 'web result'),
        content: snippet || undefined,
        source: `web_search:${row.source ?? 'unknown'}`,
        sourceType: 'news',
        url: typeof row.url === 'string' ? row.url : undefined,
        timestamp: typeof row.date === 'string' ? row.date : new Date().toISOString(),
      });
    }
  }
  const extraction = extractEventsFromIntel(intelItems);
  const eventRows = extraction.events.map(({ event, sourceIntel }) => {
    const thought = ensureThoughtForEvent(event, sourceIntel);
    const forecasts = ensureForecastsForThought(event, thought);
    return {
      event,
      thought,
      forecasts,
    };
  });

  let marketSnapshots: Array<{ symbol: string; markPrice: number | null }> = [];
  if (config) {
    const marketClient = createMarketClient(config);
    marketSnapshots = await collectForecastMarketSnapshot(marketClient, [
      ...contextPlan.symbolHints,
      ...eventRows.flatMap((row) => row.forecasts.map((forecast) => forecast.asset)),
    ]);
    sweepExpiredForecasts();
  }

  const sources = [market, time, ...intelResults, ...webResults, ...fundingResults]
    .filter((result) => result.success)
    .map((result) => result.source);

  const snapshot: ProactiveRefreshSnapshot = {
    asOf: new Date().toISOString(),
    query: message,
    domain: contextPlan.domain,
    sources,
    data: {
      currentTime: time.success ? time.data : undefined,
      markets: market.success ? market.data : undefined,
      marketContext: contextPlan,
      marketSnapshots: marketSnapshots.length > 0 ? marketSnapshots : undefined,
      intel:
        intelResults.some((result) => result.success)
          ? intelResults.filter((result) => result.success).map((result) => ({
              query: result.source.replace(/^intel_search:/, ''),
              data: result.data,
            }))
          : undefined,
      web:
        webResults.some((result) => result.success)
          ? webResults.filter((result) => result.success).map((result) => ({
              query: result.source.replace(/^web_search:/, ''),
              data: result.data,
            }))
          : undefined,
      fundingOISkew: fundingSignals.length > 0 ? fundingSignals : undefined,
      events: eventRows.length > 0 ? eventRows : undefined,
      extractionGaps: extraction.gaps.length > 0 ? extraction.gaps : undefined,
    },
  };

  return {
    triggered: true,
    fromCache: false,
    failClosed: false,
    snapshot,
    contextText: buildContextFromSnapshot(snapshot),
  };
}
