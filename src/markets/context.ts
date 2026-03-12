export type MarketContextDomain =
  | 'crypto'
  | 'energy'
  | 'metals'
  | 'agri'
  | 'macro'
  | 'equity'
  | 'rates'
  | 'fx'
  | 'other';

export interface MarketContextPlan {
  domain: MarketContextDomain;
  searchQueries: string[];
  symbolHints: string[];
  requiresDomainSpecificRetrieval: boolean;
  includeFundingSignals: boolean;
  retrievalGapMessage: string;
}

const DOMAIN_KEYWORDS: Array<{ domain: MarketContextDomain; patterns: RegExp[] }> = [
  {
    domain: 'energy',
    patterns: [/\b(oil|crude|wti|brent|cl|natgas|natural gas|opec|hormuz|iran)\b/i],
  },
  {
    domain: 'metals',
    patterns: [/\b(gold|silver|copper|platinum|palladium|xau|xag)\b/i],
  },
  {
    domain: 'agri',
    patterns: [/\b(wheat|corn|soy|soybean|coffee|cocoa|sugar|grain|crop|frost|drought)\b/i],
  },
  {
    domain: 'fx',
    patterns: [/\b(usd|dxy|eurusd|usdjpy|fx|foreign exchange|sterling|yen|euro)\b/i],
  },
  {
    domain: 'rates',
    patterns: [/\b(yield|treasury|fed funds|rates|bond market|duration)\b/i],
  },
  {
    domain: 'equity',
    patterns: [/\b(stock|stocks|equity|equities|nasdaq|s&p|spx|dow|nikkei)\b/i],
  },
  {
    domain: 'macro',
    patterns: [/\b(cpi|inflation|gdp|macro|economy|recession|tariff|sanction)\b/i],
  },
  {
    domain: 'crypto',
    patterns: [/\b(bitcoin|btc|eth|sol|altcoin|crypto|perp|funding)\b/i],
  },
];

const DOMAIN_SYMBOL_HINTS: Record<MarketContextDomain, string[]> = {
  crypto: ['BTC', 'ETH', 'SOL'],
  energy: ['CL', 'BRENTOIL', 'NATGAS', 'COPPER'],
  metals: ['GOLD', 'SILVER', 'COPPER'],
  agri: ['WHEAT', 'CORN', 'COFFEE'],
  macro: ['DXY', 'VIX', 'GOLD', 'CL'],
  equity: ['SPX', 'NVDA', 'AAPL'],
  rates: ['DXY', 'GOLD'],
  fx: ['EUR', 'JPY', 'DXY'],
  other: [],
};

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

function uniq(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function inferMarketContextDomain(message: string): MarketContextDomain {
  for (const entry of DOMAIN_KEYWORDS) {
    if (entry.patterns.some((pattern) => pattern.test(message))) {
      return entry.domain;
    }
  }
  return 'other';
}

export function buildMarketContextPlan(message: string): MarketContextPlan {
  const domain = inferMarketContextDomain(message);
  const normalizedMessage = normalizeQuery(message);

  const searchQueries = [normalizedMessage];
  if (domain === 'energy') {
    searchQueries.push('oil supply disruption');
    if (/\biran|hormuz\b/i.test(message)) {
      searchQueries.push('Iran Hormuz oil disruption');
      searchQueries.push('Strait of Hormuz tanker disruption');
    }
  } else if (domain === 'metals') {
    searchQueries.push('gold safe haven demand');
  } else if (domain === 'agri') {
    searchQueries.push('crop supply shock');
  } else if (domain === 'macro') {
    searchQueries.push('macro catalyst market impact');
  }

  const retrievalGapMessage =
    domain === 'other'
      ? 'I need topic-specific sourcing before concluding there is no catalyst.'
      : `I need ${domain}-specific sourcing before concluding there is no catalyst.`;

  return {
    domain,
    searchQueries: uniq(searchQueries),
    symbolHints: DOMAIN_SYMBOL_HINTS[domain],
    requiresDomainSpecificRetrieval: domain !== 'crypto' && domain !== 'other',
    includeFundingSignals: domain === 'crypto',
    retrievalGapMessage,
  };
}
