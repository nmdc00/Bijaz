import type { ToolResult } from './tool-executor.js';

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
  sources: string[];
  data: {
    currentTime?: unknown;
    markets?: unknown;
    intel?: unknown;
    web?: unknown;
    fundingOISkew?: Array<{ symbol: string; signal: unknown }>;
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
  /\b(latest|today|yesterday|this\s+(week|month|year)|right now|currently|bull|bear|risk[- ]?on|risk[- ]?off|macro|regime|outlook|headline|news)\b/i;

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

  const fundingSymbols = settings.fundingSymbols.slice(0, 3);
  const marketPromise = runTool(
    executeTool,
    'perp_market_list',
    { limit: Math.max(1, settings.marketLimit) },
    settings.maxLatencyMs
  );
  const timePromise = runTool(executeTool, 'current_time', {}, settings.maxLatencyMs);
  const intelPromise = runTool(
    executeTool,
    'intel_search',
    { query: message, limit: Math.max(1, settings.intelLimit) },
    settings.maxLatencyMs
  );
  const webPromise = runTool(
    executeTool,
    'web_search',
    { query: message, limit: Math.max(1, settings.webLimit) },
    settings.maxLatencyMs
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

  const [market, time, intel, web, ...fundingResults] = await Promise.all([
    marketPromise,
    timePromise,
    intelPromise,
    webPromise,
    ...fundingPromises,
  ]);

  const hasMarket = market.success;
  const hasNews = intel.success || web.success;
  const hasTiming = time.success;
  const hasSignal = fundingResults.some((result) => result.success);
  const sufficientEvidence = hasMarket && (hasNews || hasSignal || hasTiming);

  if (!sufficientEvidence && settings.strictFailClosed) {
    const reasons = [market, time, intel, web, ...fundingResults]
      .filter((item) => !item.success)
      .map((item) => `${item.source}: ${item.error ?? 'failed'}`)
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
      const symbol = result.source.split(':')[1] ?? 'unknown';
      return { symbol, signal: result.data };
    });

  const sources = [market, time, intel, web, ...fundingResults]
    .filter((result) => result.success)
    .map((result) => result.source);

  const snapshot: ProactiveRefreshSnapshot = {
    asOf: new Date().toISOString(),
    query: message,
    sources,
    data: {
      currentTime: time.success ? time.data : undefined,
      markets: market.success ? market.data : undefined,
      intel: intel.success ? intel.data : undefined,
      web: web.success ? web.data : undefined,
      fundingOISkew: fundingSignals.length > 0 ? fundingSignals : undefined,
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
