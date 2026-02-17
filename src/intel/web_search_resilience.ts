import type { ThufirConfig } from '../core/config.js';

export type WebSearchProviderName = 'brave' | 'perplexity' | 'serpapi' | 'duckduckgo';

export type WebSearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  date: string | null;
  source: string | null;
};

type WebSearchAttempt = {
  provider: WebSearchProviderName;
  status: 'ok' | 'failed' | 'skipped';
  error_class?: string;
  error?: string;
  latency_ms: number;
};

export type WebSearchResultEnvelope = {
  as_of: string;
  query: string;
  provider: WebSearchProviderName;
  provider_used: WebSearchProviderName;
  cache: {
    hit: boolean;
    key: string;
    ttl_seconds: number;
  };
  attempts: WebSearchAttempt[];
  results: WebSearchResultItem[];
};

type WebSearchFailure = {
  provider: WebSearchProviderName;
  message: string;
  classification:
    | 'quota_exhausted'
    | 'rate_limited'
    | 'timeout'
    | 'provider_5xx'
    | 'network_error'
    | 'invalid_api_key'
    | 'provider_misconfigured'
    | 'unsupported_request'
    | 'unknown';
};

type WebSearchProviderResult =
  | { ok: true; results: WebSearchResultItem[] }
  | { ok: false; failure: WebSearchFailure };

type WebSearchCacheEntry = {
  expiresAtMs: number;
  value: WebSearchResultEnvelope;
};

type CircuitState = {
  failures: number;
  openUntilMs: number;
};

type DailyUsage = {
  day: string;
  totalAttempts: number;
  providerAttempts: Record<string, number>;
};

const cacheState = new Map<string, WebSearchCacheEntry>();
const circuitState = new Map<WebSearchProviderName, CircuitState>();
let dailyUsage: DailyUsage = {
  day: currentUtcDay(),
  totalAttempts: 0,
  providerAttempts: {},
};

function currentUtcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildCacheKey(query: string, limit: number, order: WebSearchProviderName[]): string {
  return `${normalizeQuery(query)}|${Math.max(1, limit)}|${order.join(',')}`;
}

function resetDailyUsageIfNeeded(now = new Date()): void {
  const day = currentUtcDay(now);
  if (dailyUsage.day !== day) {
    dailyUsage = { day, totalAttempts: 0, providerAttempts: {} };
  }
}

function classifyWebSearchFailure(message: string): WebSearchFailure['classification'] {
  const text = message.toLowerCase();
  if (text.includes('quota') || text.includes('exhausted')) return 'quota_exhausted';
  if (text.includes('429') || text.includes('rate limit') || text.includes('too many requests')) {
    return 'rate_limited';
  }
  if (text.includes('timeout') || text.includes('timed out') || text.includes('abort')) return 'timeout';
  if (text.includes('5')) {
    const statusMatch = text.match(/\b5\d\d\b/);
    if (statusMatch) return 'provider_5xx';
  }
  if (text.includes('enotfound') || text.includes('eai_again') || text.includes('network')) {
    return 'network_error';
  }
  if (text.includes('invalid') && text.includes('key')) return 'invalid_api_key';
  if (text.includes('not configured') || text.includes('missing')) return 'provider_misconfigured';
  if (text.includes('unsupported')) return 'unsupported_request';
  return 'unknown';
}

function pruneCache(maxEntries: number): void {
  if (cacheState.size <= maxEntries) return;
  const entries = Array.from(cacheState.entries()).sort((a, b) => a[1].expiresAtMs - b[1].expiresAtMs);
  const removeCount = Math.max(1, cacheState.size - maxEntries);
  for (const [key] of entries.slice(0, removeCount)) {
    cacheState.delete(key);
  }
}

function loadProviderOrder(config: ThufirConfig): WebSearchProviderName[] {
  const configured = config.intel?.webSearch?.providers?.order;
  const fallback: WebSearchProviderName[] = ['brave', 'serpapi', 'duckduckgo'];
  if (!Array.isArray(configured) || configured.length === 0) return fallback;
  const unique: WebSearchProviderName[] = [];
  for (const provider of configured) {
    if (!unique.includes(provider)) unique.push(provider);
  }
  return unique.length > 0 ? unique : fallback;
}

function providerEnabled(config: ThufirConfig, provider: WebSearchProviderName): boolean {
  const node = config.intel?.webSearch?.providers?.[provider];
  if (provider === 'duckduckgo') {
    return node?.enabled ?? true;
  }
  return node?.enabled ?? true;
}

function providerApiKey(config: ThufirConfig, provider: WebSearchProviderName): string | null {
  const providerNode = config.intel?.webSearch?.providers?.[provider];
  const fromConfig =
    providerNode && typeof providerNode === 'object' && 'apiKey' in providerNode
      ? providerNode.apiKey?.trim()
      : undefined;
  if (fromConfig) return fromConfig;
  switch (provider) {
    case 'brave':
      return process.env.BRAVE_API_KEY?.trim() || null;
    case 'serpapi':
      return process.env.SERPAPI_KEY?.trim() || null;
    case 'perplexity':
      return process.env.PERPLEXITY_API_KEY?.trim() || null;
    case 'duckduckgo':
      return null;
  }
}

function providerBaseUrl(config: ThufirConfig, provider: WebSearchProviderName): string {
  const configured = config.intel?.webSearch?.providers?.[provider]?.baseUrl?.trim();
  if (configured) return configured;
  switch (provider) {
    case 'brave':
      return 'https://api.search.brave.com/res/v1/web/search';
    case 'serpapi':
      return 'https://serpapi.com/search.json';
    case 'perplexity':
      return 'https://api.perplexity.ai/search';
    case 'duckduckgo':
      return 'https://api.duckduckgo.com/';
  }
}

async function searchViaSerpApi(
  query: string,
  limit: number,
  config: ThufirConfig
): Promise<WebSearchProviderResult> {
  const apiKey = providerApiKey(config, 'serpapi');
  if (!apiKey) {
    return {
      ok: false,
      failure: {
        provider: 'serpapi',
        message: 'SerpAPI key not configured',
        classification: 'provider_misconfigured',
      },
    };
  }
  try {
    const url = new URL(providerBaseUrl(config, 'serpapi'));
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(limit));
    url.searchParams.set('api_key', apiKey);
    const response = await fetch(url.toString());
    if (!response.ok) {
      const message = `SerpAPI: ${response.status}`;
      return {
        ok: false,
        failure: {
          provider: 'serpapi',
          message,
          classification: classifyWebSearchFailure(message),
        },
      };
    }
    const data = (await response.json()) as {
      organic_results?: Array<{
        title?: string;
        link?: string;
        snippet?: string;
        date?: string;
        source?: string;
      }>;
    };
    const results = (data.organic_results ?? []).slice(0, limit).map((item) => ({
      title: item.title ?? '',
      url: item.link ?? '',
      snippet: item.snippet ?? '',
      date: item.date ?? null,
      source: item.source ?? 'serpapi',
    }));
    if (results.length === 0) {
      return {
        ok: false,
        failure: {
          provider: 'serpapi',
          message: 'SerpAPI returned no results',
          classification: 'unknown',
        },
      };
    }
    return { ok: true, results };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      ok: false,
      failure: {
        provider: 'serpapi',
        message,
        classification: classifyWebSearchFailure(message),
      },
    };
  }
}

async function searchViaBrave(
  query: string,
  limit: number,
  config: ThufirConfig
): Promise<WebSearchProviderResult> {
  const apiKey = providerApiKey(config, 'brave');
  if (!apiKey) {
    return {
      ok: false,
      failure: {
        provider: 'brave',
        message: 'Brave API key not configured',
        classification: 'provider_misconfigured',
      },
    };
  }
  try {
    const url = new URL(providerBaseUrl(config, 'brave'));
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });
    if (!response.ok) {
      const message = `Brave: ${response.status}`;
      return {
        ok: false,
        failure: {
          provider: 'brave',
          message,
          classification: classifyWebSearchFailure(message),
        },
      };
    }
    const data = (await response.json()) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          age?: string;
        }>;
      };
    };
    const results = (data.web?.results ?? []).slice(0, limit).map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.description ?? '',
      date: item.age ?? null,
      source: 'brave',
    }));
    if (results.length === 0) {
      return {
        ok: false,
        failure: {
          provider: 'brave',
          message: 'Brave returned no results',
          classification: 'unknown',
        },
      };
    }
    return { ok: true, results };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      ok: false,
      failure: {
        provider: 'brave',
        message,
        classification: classifyWebSearchFailure(message),
      },
    };
  }
}

type DuckDuckGoTopic = {
  Text?: string;
  FirstURL?: string;
  Topics?: DuckDuckGoTopic[];
};

function flattenDuckDuckGoTopics(topics: DuckDuckGoTopic[]): DuckDuckGoTopic[] {
  const result: DuckDuckGoTopic[] = [];
  for (const topic of topics) {
    if (Array.isArray(topic.Topics) && topic.Topics.length > 0) {
      result.push(...flattenDuckDuckGoTopics(topic.Topics));
      continue;
    }
    result.push(topic);
  }
  return result;
}

async function searchViaDuckDuckGo(
  query: string,
  limit: number,
  config: ThufirConfig
): Promise<WebSearchProviderResult> {
  try {
    const url = new URL(providerBaseUrl(config, 'duckduckgo'));
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_redirect', '1');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('skip_disambig', '1');
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      const message = `DuckDuckGo: ${response.status}`;
      return {
        ok: false,
        failure: {
          provider: 'duckduckgo',
          message,
          classification: classifyWebSearchFailure(message),
        },
      };
    }
    const data = (await response.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: DuckDuckGoTopic[];
    };
    const results: WebSearchResultItem[] = [];
    if (data.AbstractURL && data.AbstractText) {
      results.push({
        title: data.Heading?.trim() || query,
        url: data.AbstractURL,
        snippet: data.AbstractText,
        date: null,
        source: 'duckduckgo',
      });
    }
    const flat = flattenDuckDuckGoTopics(data.RelatedTopics ?? []);
    for (const topic of flat) {
      if (results.length >= limit) break;
      const text = (topic.Text ?? '').trim();
      const link = (topic.FirstURL ?? '').trim();
      if (!text || !link) continue;
      results.push({
        title: text.split(' - ')[0]?.trim() || text.slice(0, 80),
        url: link,
        snippet: text,
        date: null,
        source: 'duckduckgo',
      });
    }
    const trimmed = results.slice(0, limit);
    if (trimmed.length === 0) {
      return {
        ok: false,
        failure: {
          provider: 'duckduckgo',
          message: 'DuckDuckGo returned no results',
          classification: 'unknown',
        },
      };
    }
    return { ok: true, results: trimmed };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      ok: false,
      failure: {
        provider: 'duckduckgo',
        message,
        classification: classifyWebSearchFailure(message),
      },
    };
  }
}

async function searchViaPerplexity(
  query: string,
  limit: number,
  config: ThufirConfig
): Promise<WebSearchProviderResult> {
  const apiKey = providerApiKey(config, 'perplexity');
  if (!apiKey) {
    return {
      ok: false,
      failure: {
        provider: 'perplexity',
        message: 'Perplexity API key not configured',
        classification: 'provider_misconfigured',
      },
    };
  }
  try {
    const url = providerBaseUrl(config, 'perplexity');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: limit,
      }),
    });
    if (!response.ok) {
      const message = `Perplexity: ${response.status}`;
      return {
        ok: false,
        failure: {
          provider: 'perplexity',
          message,
          classification: classifyWebSearchFailure(message),
        },
      };
    }
    const data = (await response.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        snippet?: string;
        date?: string;
      }>;
      web_results?: Array<{
        title?: string;
        url?: string;
        snippet?: string;
        published_date?: string;
      }>;
    };
    const rows = (data.results ?? data.web_results ?? []).slice(0, limit);
    const results = rows.map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.snippet ?? '',
      date: ('date' in item ? item.date : (item as { published_date?: string }).published_date) ?? null,
      source: 'perplexity',
    }));
    if (results.length === 0) {
      return {
        ok: false,
        failure: {
          provider: 'perplexity',
          message: 'Perplexity returned no results',
          classification: 'unknown',
        },
      };
    }
    return { ok: true, results };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      ok: false,
      failure: {
        provider: 'perplexity',
        message,
        classification: classifyWebSearchFailure(message),
      },
    };
  }
}

async function callProvider(
  provider: WebSearchProviderName,
  query: string,
  limit: number,
  config: ThufirConfig
): Promise<WebSearchProviderResult> {
  switch (provider) {
    case 'brave':
      return searchViaBrave(query, limit, config);
    case 'perplexity':
      return searchViaPerplexity(query, limit, config);
    case 'serpapi':
      return searchViaSerpApi(query, limit, config);
    case 'duckduckgo':
      return searchViaDuckDuckGo(query, limit, config);
  }
}

export function resetWebSearchResilienceStateForTests(): void {
  cacheState.clear();
  circuitState.clear();
  dailyUsage = { day: currentUtcDay(), totalAttempts: 0, providerAttempts: {} };
}

export async function resilientWebSearch(
  query: string,
  limit: number,
  config: ThufirConfig
): Promise<{ success: true; data: WebSearchResultEnvelope } | { success: false; error: string }> {
  const enabled = config.intel?.webSearch?.enabled ?? true;
  if (!enabled) {
    return { success: false, error: 'Web search is disabled by config' };
  }

  const order = loadProviderOrder(config);
  const safeLimit = Math.min(Math.max(limit, 1), 10);
  const cacheTtlSeconds = Math.max(0, config.intel?.webSearch?.cache?.ttlSeconds ?? 900);
  const cacheEnabled = config.intel?.webSearch?.cache?.enabled ?? true;
  const cacheMaxEntries = Math.max(10, config.intel?.webSearch?.cache?.maxEntries ?? 5000);
  const cacheKey = buildCacheKey(query, safeLimit, order);
  const nowMs = Date.now();

  if (cacheEnabled) {
    const cached = cacheState.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) {
      return {
        success: true,
        data: {
          ...cached.value,
          cache: { ...cached.value.cache, hit: true },
          attempts: [],
        },
      };
    }
  }

  resetDailyUsageIfNeeded();
  const maxQueriesPerDay = Math.max(1, config.intel?.webSearch?.budgets?.maxQueriesPerDay ?? 500);
  if (dailyUsage.totalAttempts >= maxQueriesPerDay) {
    return { success: false, error: 'Web search daily budget exhausted' };
  }

  const perProviderCaps = config.intel?.webSearch?.budgets?.perProviderDailyCaps ?? {};
  const breakerThreshold = Math.max(1, config.intel?.webSearch?.circuitBreaker?.failureThreshold ?? 5);
  const breakerOpenSeconds = Math.max(1, config.intel?.webSearch?.circuitBreaker?.openSeconds ?? 300);
  const attempts: WebSearchAttempt[] = [];
  const failures: string[] = [];

  for (const provider of order) {
    if (!providerEnabled(config, provider)) {
      attempts.push({ provider, status: 'skipped', error: 'provider disabled', latency_ms: 0 });
      continue;
    }

    const providerCap = perProviderCaps[provider];
    const providerAttempts = dailyUsage.providerAttempts[provider] ?? 0;
    if (typeof providerCap === 'number' && providerAttempts >= providerCap) {
      attempts.push({
        provider,
        status: 'skipped',
        error_class: 'quota_exhausted',
        error: 'provider daily cap reached',
        latency_ms: 0,
      });
      continue;
    }

    const breaker = circuitState.get(provider) ?? { failures: 0, openUntilMs: 0 };
    if (breaker.openUntilMs > nowMs) {
      attempts.push({
        provider,
        status: 'skipped',
        error_class: 'rate_limited',
        error: 'circuit open',
        latency_ms: 0,
      });
      continue;
    }

    const start = Date.now();
    dailyUsage.totalAttempts += 1;
    dailyUsage.providerAttempts[provider] = providerAttempts + 1;
    const providerResult = await callProvider(provider, query, safeLimit, config);
    const latencyMs = Date.now() - start;

    if (providerResult.ok) {
      circuitState.set(provider, { failures: 0, openUntilMs: 0 });
      const response: WebSearchResultEnvelope = {
        as_of: new Date().toISOString(),
        query,
        provider,
        provider_used: provider,
        cache: {
          hit: false,
          key: cacheKey,
          ttl_seconds: cacheTtlSeconds,
        },
        attempts: [...attempts, { provider, status: 'ok', latency_ms: latencyMs }],
        results: providerResult.results,
      };
      if (cacheEnabled) {
        cacheState.set(cacheKey, {
          expiresAtMs: nowMs + cacheTtlSeconds * 1000,
          value: response,
        });
        pruneCache(cacheMaxEntries);
      }
      return { success: true, data: response };
    }

    const failure = providerResult.failure;
    const prevFailures = breaker.failures + 1;
    const shouldOpen = prevFailures >= breakerThreshold;
    circuitState.set(provider, {
      failures: prevFailures,
      openUntilMs: shouldOpen ? nowMs + breakerOpenSeconds * 1000 : 0,
    });
    attempts.push({
      provider,
      status: 'failed',
      error_class: failure.classification,
      error: failure.message,
      latency_ms: latencyMs,
    });
    failures.push(`${provider}:${failure.classification}:${failure.message}`);
  }

  return {
    success: false,
    error: `Web search failed across providers. ${failures.join(' | ') || 'No providers available'}`,
  };
}
