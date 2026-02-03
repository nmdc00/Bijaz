import { listRecentIntel } from '../intel/store.js';
import type { NewsSentiment } from './types.js';

const POSITIVE = new Set([
  'beat', 'beats', 'beating', 'surge', 'surges', 'surged', 'rally', 'rallies', 'rallied',
  'win', 'wins', 'won', 'strong', 'growth', 'record', 'up', 'upgrade', 'upgrades',
  'boom', 'positive', 'bullish', 'soar', 'soars', 'soared',
]);
const NEGATIVE = new Set([
  'miss', 'misses', 'missed', 'fall', 'falls', 'fell', 'drop', 'drops', 'dropped',
  'crash', 'crashes', 'crashed', 'loss', 'losses', 'weak', 'decline', 'declines',
  'declined', 'down', 'downgrade', 'downgrades', 'bust', 'negative', 'bearish',
  'plunge', 'plunges', 'plunged',
]);

function scoreSentiment(text: string): number {
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    if (POSITIVE.has(token)) score += 1;
    if (NEGATIVE.has(token)) score -= 1;
  }
  if (tokens.length === 0) return 0;
  return score / Math.min(tokens.length, 50);
}

function buildSymbolKeywords(symbol: string): string[] {
  const base = symbol.split('/')[0] ?? symbol;
  const key = base.toUpperCase();
  if (key === 'BTC') return ['btc', 'bitcoin'];
  if (key === 'ETH') return ['eth', 'ethereum'];
  return [base.toLowerCase()];
}

export function getNewsSentiment(symbol: string, limit = 50): NewsSentiment {
  const keywords = buildSymbolKeywords(symbol);
  const items = listRecentIntel(limit);
  const matched = items.filter((item) => {
    const text = `${item.title ?? ''} ${item.content ?? ''}`.toLowerCase();
    return keywords.some((keyword) => text.includes(keyword));
  });

  if (matched.length === 0) {
    return {
      sentiment: 0,
      reasoning: ['No recent intel matched this symbol.'],
      matchedItems: [],
    };
  }

  let total = 0;
  const scored = matched.slice(0, 10).map((item) => {
    const text = `${item.title ?? ''} ${item.content ?? ''}`;
    const score = scoreSentiment(text);
    total += score;
    return {
      title: item.title ?? 'Untitled',
      source: item.source,
      timestamp: item.timestamp,
      score,
    };
  });

  const average = total / scored.length;
  const reasoning = [
    `Matched ${scored.length} intel items for ${symbol}.`,
    `Average sentiment score: ${average.toFixed(2)}.`,
  ];

  return {
    sentiment: average,
    reasoning,
    matchedItems: scored,
  };
}
