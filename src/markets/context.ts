import type { ToolResult } from '../core/tool-executor.js';

export type MarketContextDomain =
  | 'crypto'
  | 'energy'
  | 'agri'
  | 'metals'
  | 'rates'
  | 'fx'
  | 'equity'
  | 'macro';

export interface MarketContextQuery {
  message: string;
  domain?: MarketContextDomain | null;
  marketLimit?: number;
  signalSymbols?: string[];
}

export interface MarketContextToolRequest {
  toolName: string;
  input: Record<string, unknown>;
  label: string;
  required: boolean;
}

export interface MarketContextSnapshot {
  domain: MarketContextDomain;
  primarySource: string;
  sources: string[];
  results: Array<{
    label: string;
    toolName: string;
    required: boolean;
    success: boolean;
    data?: unknown;
    error?: string;
  }>;
}

type ExecuteToolFn = (toolName: string, input: Record<string, unknown>) => Promise<ToolResult>;

const DOMAIN_KEYWORDS: Array<{ domain: MarketContextDomain; keywords: string[] }> = [
  { domain: 'energy', keywords: ['oil', 'crude', 'brent', 'wti', 'natgas', 'natural gas', 'lng', 'opec', 'hormuz', 'diesel', 'gasoline'] },
  { domain: 'agri', keywords: ['wheat', 'corn', 'soy', 'soybean', 'coffee', 'cocoa', 'sugar', 'crop', 'grain', 'harvest', 'drought', 'frost'] },
  { domain: 'metals', keywords: ['gold', 'silver', 'copper', 'aluminum', 'nickel', 'xau', 'xag'] },
  { domain: 'rates', keywords: ['fed', 'ecb', 'boj', 'rate', 'rates', 'yield', 'treasury', 'bond'] },
  { domain: 'fx', keywords: ['fx', 'currency', 'dollar', 'usd', 'eur', 'jpy', 'yuan'] },
  { domain: 'equity', keywords: ['stock', 'stocks', 'equity', 'earnings', 'nasdaq', 's&p', 'sp500', 'dow'] },
  { domain: 'crypto', keywords: ['btc', 'bitcoin', 'eth', 'ethereum', 'sol', 'solana', 'crypto', 'token', 'perp', 'funding'] },
];

export function classifyMarketContextDomain(message: string): MarketContextDomain {
  const haystack = message.toLowerCase();
  let bestDomain: MarketContextDomain = 'macro';
  let bestScore = 0;

  for (const rule of DOMAIN_KEYWORDS) {
    const score = rule.keywords.reduce(
      (sum, keyword) => sum + (haystack.includes(keyword.toLowerCase()) ? 1 : 0),
      0
    );
    if (score > bestScore) {
      bestScore = score;
      bestDomain = rule.domain;
    }
  }

  return bestDomain;
}

function defaultSignalSymbols(domain: MarketContextDomain): string[] {
  switch (domain) {
    case 'crypto':
      return ['BTC', 'ETH'];
    case 'energy':
      return ['CL', 'BRENTOIL', 'GOLD'];
    case 'agri':
      return ['WHEAT', 'CORN'];
    case 'metals':
      return ['GOLD', 'SILVER'];
    case 'rates':
      return ['DXY', 'TLT'];
    case 'fx':
      return ['DXY', 'EURUSD'];
    case 'equity':
      return ['SPY', 'QQQ'];
    default:
      return ['DXY', 'GOLD'];
  }
}

export function buildMarketContextRequests(query: MarketContextQuery): MarketContextToolRequest[] {
  const domain = query.domain ?? classifyMarketContextDomain(query.message);
  const marketLimit = Math.max(1, query.marketLimit ?? (domain === 'crypto' ? 20 : 200));
  const signalSymbols = (query.signalSymbols && query.signalSymbols.length > 0
    ? query.signalSymbols
    : defaultSignalSymbols(domain)
  ).slice(0, 3);

  const requests: MarketContextToolRequest[] = [
    { toolName: 'current_time', input: {}, label: 'current_time', required: false },
    {
      toolName: 'intel_search',
      input: { query: query.message, limit: 5 },
      label: 'intel_search',
      required: false,
    },
    {
      toolName: 'web_search',
      input: { query: query.message, limit: 5 },
      label: 'web_search',
      required: false,
    },
  ];

  if (domain === 'crypto') {
    requests.push({
      toolName: 'perp_market_list',
      input: { limit: marketLimit },
      label: 'perp_market_list',
      required: true,
    });
    for (const symbol of signalSymbols) {
      requests.push({
        toolName: 'signal_hyperliquid_funding_oi_skew',
        input: { symbol },
        label: `signal_hyperliquid_funding_oi_skew:${symbol}`,
        required: false,
      });
    }
    return requests;
  }

  requests.push({
    toolName: 'web_search',
    input: { query: `${query.message} market impact ${domain}`, limit: 5 },
    label: `web_search:market_context:${domain}`,
    required: true,
  });

  return requests;
}

export async function gatherMarketContext(
  query: MarketContextQuery,
  executeTool: ExecuteToolFn
): Promise<MarketContextSnapshot> {
  const domain = query.domain ?? classifyMarketContextDomain(query.message);
  const requests = buildMarketContextRequests({ ...query, domain });
  const results: MarketContextSnapshot['results'] = [];

  for (const request of requests) {
    try {
      const outcome = await executeTool(request.toolName, request.input);
      results.push({
        label: request.label,
        toolName: request.toolName,
        required: request.required,
        success: outcome.success,
        data: outcome.success ? outcome.data : undefined,
        error: outcome.success ? undefined : (outcome as { error?: string }).error ?? `${request.toolName} failed`,
      });
    } catch (error) {
      results.push({
        label: request.label,
        toolName: request.toolName,
        required: request.required,
        success: false,
        error: error instanceof Error ? error.message : `${request.toolName} failed`,
      });
    }
  }

  const primary = domain === 'crypto' ? 'perp_market_list' : `web_search:market_context:${domain}`;
  return {
    domain,
    primarySource: primary,
    sources: results.filter((result) => result.success).map((result) => result.label),
    results,
  };
}
