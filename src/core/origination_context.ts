import type { MarketContextDomain } from '../markets/context.js';
import type { HistoricalEventCase } from '../events/casebase.js';
import type { EventForecast, EventOutcome, EventThought, NormalizedEvent } from '../events/types.js';

const NON_CRYPTO_PRIORITY: MarketContextDomain[] = ['energy', 'metals', 'agri', 'rates', 'fx', 'equity', 'macro'];

function normalizeSymbolRoot(symbol: string): string {
  const upper = String(symbol ?? '').trim().toUpperCase();
  const withoutQuote = upper.split('/')[0] ?? upper;
  return withoutQuote.includes(':') ? (withoutQuote.split(':').pop() ?? withoutQuote) : withoutQuote;
}

function domainFromSymbol(symbol: string): MarketContextDomain | null {
  const root = normalizeSymbolRoot(symbol);
  if (['CL', 'WTI', 'BRENTOIL', 'NATGAS', 'LNG', 'OIL'].includes(root)) return 'energy';
  if (['GOLD', 'SILVER', 'COPPER', 'ALUMINUM', 'NICKEL', 'XAU', 'XAG'].includes(root)) return 'metals';
  if (['WHEAT', 'CORN', 'COFFEE', 'COCOA', 'SUGAR', 'SOY', 'SOYBEAN'].includes(root)) return 'agri';
  if (['DXY', 'TLT', 'ZN', 'ZB'].includes(root)) return 'rates';
  if (['EURUSD', 'USDJPY', 'GBPUSD', 'AUDUSD'].includes(root)) return 'fx';
  if (['SP500', 'SPX', 'QQQ', 'SPY', 'NVDA', 'TSLA', 'AAPL', 'SNDK', 'CRCL'].includes(root)) return 'equity';
  if (['BTC', 'ETH', 'SOL', 'HYPE', 'ZEC', 'XRP', 'DOGE', 'SUI', 'TON', 'LINK', 'NEAR'].includes(root)) return 'crypto';
  return root.startsWith('XYZ') ? 'equity' : null;
}

export function resolveOriginationContextDomain(topMarkets: string[], recentEvents: NormalizedEvent[]): MarketContextDomain {
  const scores = new Map<MarketContextDomain, number>();
  const add = (domain: string | null | undefined, weight: number) => {
    if (!domain) return;
    const normalized = domain as MarketContextDomain;
    scores.set(normalized, (scores.get(normalized) ?? 0) + weight);
  };

  for (const symbol of topMarkets.slice(0, 12)) {
    add(domainFromSymbol(symbol), 2);
  }
  for (const event of recentEvents.slice(0, 10)) {
    add(event.domain, 1);
    if (event.domain !== 'crypto' && topMarkets.some((symbol) => domainFromSymbol(symbol) === event.domain)) {
      add(event.domain, 4);
    }
  }

  for (const preferred of NON_CRYPTO_PRIORITY) {
    if ((scores.get(preferred) ?? 0) > 0) {
      const bestScore = Math.max(...scores.values(), 0);
      if ((scores.get(preferred) ?? 0) >= bestScore) {
        return preferred;
      }
    }
  }

  let bestDomain: MarketContextDomain = 'crypto';
  let bestScore = -1;
  for (const [domain, score] of scores.entries()) {
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  return bestScore >= 0 ? bestDomain : 'crypto';
}

function extractMechanismQuery(thought: EventThought | null, event: NormalizedEvent): string | undefined {
  const haystack = `${thought?.mechanism ?? ''}\n${thought?.causalChain.join(' ') ?? ''}\n${event.tags.join(' ')}`.toLowerCase();
  const candidates = [
    'supply',
    'demand',
    'attack',
    'sanction',
    'export',
    'weather',
    'inflation',
    'rate',
    'shipping',
    'logistics',
    'outage',
    'refinery',
    'harvest',
  ];
  return candidates.find((keyword) => haystack.includes(keyword));
}

function summarizeForecasts(forecasts: EventForecast[]): string {
  if (forecasts.length === 0) return 'no linked forecasts';
  return forecasts
    .slice(0, 4)
    .map((forecast) => `${forecast.asset} ${forecast.direction} ${forecast.horizonHours}h conf=${forecast.confidence.toFixed(2)} status=${forecast.status}`)
    .join('; ');
}

function summarizeOutcomes(outcomes: EventOutcome[]): string {
  if (outcomes.length === 0) return 'no resolved outcomes yet';
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    counts.set(outcome.resolutionStatus, (counts.get(outcome.resolutionStatus) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
}

function summarizeCases(cases: HistoricalEventCase[]): string {
  if (cases.length === 0) return 'no close historical analogs found';
  return cases
    .slice(0, 2)
    .map((entry) => `${entry.case_key}: ${entry.forecast.direction} via ${entry.mechanism}`)
    .join(' | ');
}

function eventMatchesFocus(params: {
  event: NormalizedEvent;
  focusDomain: MarketContextDomain;
  topMarkets: string[];
  thought: EventThought | null;
}): boolean {
  if (params.event.domain === params.focusDomain) return true;
  const impactedRoots = (params.thought?.impactedAssets ?? []).map((asset) => normalizeSymbolRoot(asset.symbol));
  const marketRoots = new Set(params.topMarkets.map(normalizeSymbolRoot));
  return impactedRoots.some((root) => marketRoots.has(root));
}

export function buildOriginationEventContext(params: {
  topMarkets: string[];
  recentEvents: NormalizedEvent[];
  focusDomain: MarketContextDomain;
  getLatestThought: (eventId: string) => EventThought | null;
  listForecastsForEvent: (eventId: string) => EventForecast[];
  listOutcomesForEvent: (eventId: string) => EventOutcome[];
  searchHistoricalCases: (input: {
    domain?: string;
    tags?: string[];
    mechanismQuery?: string;
    limit?: number;
  }) => HistoricalEventCase[];
}): string {
  const sections: string[] = [];
  for (const event of params.recentEvents) {
    const thought = params.getLatestThought(event.id);
    if (!eventMatchesFocus({ event, focusDomain: params.focusDomain, topMarkets: params.topMarkets, thought })) {
      continue;
    }
    const forecasts = params.listForecastsForEvent(event.id);
    const outcomes = params.listOutcomesForEvent(event.id);
    const historicalCases = params.searchHistoricalCases({
      domain: event.domain,
      tags: event.tags,
      mechanismQuery: extractMechanismQuery(thought, event),
      limit: 2,
    });
    const impacted = thought?.impactedAssets.length
      ? thought.impactedAssets.map((asset) => `${asset.symbol} ${asset.direction} (${asset.confidence.toFixed(2)})`).join(', ')
      : 'none';
    sections.push([
      `[${event.domain}] ${event.title}`,
      `tags: ${event.tags.join(', ') || 'none'}`,
      `thought: ${thought?.mechanism ?? 'no thought artifact yet'}`,
      `impacted: ${impacted}`,
      `forecasts: ${summarizeForecasts(forecasts)}`,
      `outcomes: ${summarizeOutcomes(outcomes)}`,
      `historical_analogs: ${summarizeCases(historicalCases)}`,
    ].join('\n'));
    if (sections.length >= 3) break;
  }

  return sections.length > 0 ? sections.join('\n\n') : '(no materially relevant event artifacts)';
}
