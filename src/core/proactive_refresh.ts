import type { ToolResult } from './tool-executor.js';
import { gatherMarketContext, type MarketContextDomain } from '../markets/context.js';

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
  domain: MarketContextDomain;
  sources: string[];
  data: {
    currentTime?: unknown;
    markets?: unknown;
    intel?: unknown;
    web?: unknown;
    fundingOISkew?: Array<{ symbol: string; signal: unknown }>;
    marketContextPrimary?: unknown;
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
  /\b(latest|today|yesterday|this\s+(week|month|year)|right now|currently|bull|bear|risk[- ]?on|risk[- ]?off|macro|regime|outlook|headline|news|oil|gold|commodit(?:y|ies)|iran|hormuz|opec|sanctions|crude)\b/i;

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
  if (snapshot.data.fundingOISkew && snapshot.data.fundingOISkew.length > 0) {
    lines.push(`### signal_hyperliquid_funding_oi_skew\n${toSafeJson(snapshot.data.fundingOISkew)}`);
  }
  if (snapshot.data.intel !== undefined) {
    lines.push(`### intel_search\n${toSafeJson(snapshot.data.intel)}`);
  }
  if (snapshot.data.web !== undefined) {
    lines.push(`### web_search\n${toSafeJson(snapshot.data.web)}`);
  }
  if (snapshot.data.marketContextPrimary !== undefined) {
    lines.push(`### market_context_primary\n${toSafeJson(snapshot.data.marketContextPrimary)}`);
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
}): Promise<ProactiveRefreshOutcome> {
  const { message, settings, cached, executeTool } = params;
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

  const marketContext = await gatherMarketContext(
    {
      message,
      marketLimit: settings.marketLimit,
      signalSymbols: settings.fundingSymbols,
    },
    (toolName, input) => runTool(executeTool, toolName, input, settings.maxLatencyMs).then((result) => {
      if (result.success) {
        return { success: true, data: result.data };
      }
      return { success: false, error: result.error ?? `${toolName} failed` };
    })
  );

  const byLabel = new Map(marketContext.results.map((result) => [result.label, result]));
  const time = byLabel.get('current_time');
  const intel = byLabel.get('intel_search');
  const web = byLabel.get('web_search');
  const market = marketContext.results.find((result) => result.label === marketContext.primarySource);
  const fundingResults = marketContext.results.filter((result) =>
    result.label.startsWith('signal_hyperliquid_funding_oi_skew:')
  );

  const hasMarket = market?.success ?? false;
  const hasNews = Boolean(intel?.success || web?.success);
  const hasTiming = Boolean(time?.success);
  const hasSignal = fundingResults.some((result) => result.success);
  const sufficientEvidence = hasMarket && (hasNews || hasSignal || hasTiming);

  if (!sufficientEvidence && settings.strictFailClosed) {
    const reasons = marketContext.results
      .filter((item) => !item.success)
      .map((item) => `${item.label}: ${item.error ?? 'failed'}`)
      .slice(0, 4)
      .join(' | ');
    return {
      triggered: true,
      fromCache: false,
      failClosed: true,
      failReason: reasons || 'fresh data unavailable',
      contextText: '',
    };
  }

  const fundingSignals = fundingResults
    .filter((result) => result.success)
    .map((result) => {
      const symbol = result.label.split(':')[1] ?? 'unknown';
      return { symbol, signal: result.data };
    });
  const sources = marketContext.sources;

  const snapshot: ProactiveRefreshSnapshot = {
    asOf: new Date().toISOString(),
    query: message,
    domain: marketContext.domain,
    sources,
    data: {
      currentTime: time?.success ? time.data : undefined,
      markets: market?.success ? market.data : undefined,
      intel: intel?.success ? intel.data : undefined,
      web: web?.success ? web.data : undefined,
      fundingOISkew: fundingSignals.length > 0 ? fundingSignals : undefined,
      marketContextPrimary: market?.success ? market.data : undefined,
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
