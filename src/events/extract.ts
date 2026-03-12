import { listRecentIntel, type StoredIntel } from '../intel/store.js';
import { buildEventKey, upsertEvent } from '../memory/events.js';
import type { NormalizedEvent } from './types.js';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'after',
  'amid',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'of',
  'on',
  'over',
  'says',
  'the',
  'to',
  'with',
]);

const DOMAIN_RULES: Array<{ domain: string; keywords: string[] }> = [
  { domain: 'energy', keywords: ['oil', 'crude', 'brent', 'wti', 'opec', 'lng', 'refinery', 'diesel', 'gasoline', 'hormuz'] },
  { domain: 'agri', keywords: ['wheat', 'corn', 'soy', 'soybean', 'coffee', 'cocoa', 'sugar', 'grain', 'crop', 'drought', 'frost'] },
  { domain: 'metals', keywords: ['gold', 'silver', 'copper', 'aluminum', 'nickel'] },
  { domain: 'rates', keywords: ['fed', 'ecb', 'boj', 'rate', 'rates', 'yield', 'treasury'] },
  { domain: 'fx', keywords: ['dollar', 'usd', 'eur', 'jpy', 'fx', 'currency'] },
  { domain: 'crypto', keywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'crypto', 'token'] },
  { domain: 'equity', keywords: ['stock', 'stocks', 'earnings', 'equity', 'nasdaq', 's&p', 'sp500'] },
];

const TAG_RULES: Array<{ tag: string; keywords: string[] }> = [
  { tag: 'export_ban', keywords: ['export ban', 'export bans', 'export curb'] },
  { tag: 'supply_shock', keywords: ['supply shock', 'shortage', 'output cut', 'production cut', 'outage', 'disruption', 'disrupt', 'disrupted'] },
  { tag: 'attack', keywords: ['attack', 'strike', 'missile', 'drone'] },
  { tag: 'sanctions', keywords: ['sanction', 'sanctions', 'embargo'] },
  { tag: 'central_bank', keywords: ['fed', 'ecb', 'boj', 'central bank', 'rate decision'] },
  { tag: 'inflation', keywords: ['inflation', 'cpi', 'ppi'] },
  { tag: 'weather', keywords: ['drought', 'frost', 'flood', 'heatwave'] },
];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExtractedEventCandidate {
  eventKey: string;
  canonicalTitle: string;
  domain: string;
  occurredAt: string;
  sourceIntelIds: string[];
  tags: string[];
  intel: StoredIntel[];
}

export interface EventExtractionGap {
  kind: 'no_material_signals';
  message: string;
}

export interface ExtractedEventArtifact {
  event: NormalizedEvent;
  sourceIntel: StoredIntel[];
}

export interface EventExtractionResult {
  events: ExtractedEventArtifact[];
  gaps: EventExtractionGap[];
}

type IntelFeatures = {
  item: StoredIntel;
  domain: string;
  occurredAt: string;
  tokens: string[];
};

function normalizeToken(token: string): string {
  const cleaned = token.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!cleaned) return '';
  if (cleaned === 'federal' || cleaned === 'reserve') return 'fed';
  if (cleaned === 'facilities') return 'facility';
  if (cleaned === 'slower') return 'slow';
  if (cleaned.length > 4 && cleaned.endsWith('ing')) return cleaned.slice(0, -3);
  if (cleaned.length > 3 && cleaned.endsWith('ed')) return cleaned.slice(0, -2);
  if (cleaned.length > 3 && cleaned.endsWith('es')) return cleaned.slice(0, -2);
  if (cleaned.length > 3 && cleaned.endsWith('s')) return cleaned.slice(0, -1);
  return cleaned;
}

function tokenizeTitle(title: string): string[] {
  const tokens = title
    .split(/[\s/,:;()\-]+/)
    .map(normalizeToken)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  return Array.from(new Set(tokens));
}

function scoreDomain(text: string): string {
  const haystack = text.toLowerCase();
  let bestDomain = 'macro';
  let bestScore = 0;

  for (const rule of DOMAIN_RULES) {
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

function inferDomain(item: StoredIntel): string {
  const category = item.category?.toLowerCase() ?? '';
  for (const rule of DOMAIN_RULES) {
    if (category.includes(rule.domain)) {
      return rule.domain;
    }
  }
  return scoreDomain(`${item.title}\n${item.content ?? ''}`);
}

function inferTags(items: StoredIntel[]): string[] {
  const text = items.map((item) => `${item.title}\n${item.content ?? ''}`).join('\n').toLowerCase();
  const tags = TAG_RULES
    .filter((rule) => rule.keywords.some((keyword) => text.includes(keyword)))
    .map((rule) => rule.tag);
  return Array.from(new Set(tags)).sort();
}

function toFeature(item: StoredIntel): IntelFeatures {
  const occurredAt = new Date(item.timestamp).toISOString();
  return {
    item,
    domain: inferDomain(item),
    occurredAt,
    tokens: tokenizeTitle(item.title),
  };
}

function overlapCount(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) overlap += 1;
  }
  return overlap;
}

function overlapCoefficient(left: string[], right: string[]): number {
  return overlapCount(left, right) / Math.max(1, Math.min(new Set(left).size, new Set(right).size));
}

function shouldMerge(left: IntelFeatures, right: IntelFeatures): boolean {
  if (left.domain !== right.domain) return false;
  const leftMs = Date.parse(left.occurredAt);
  const rightMs = Date.parse(right.occurredAt);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return false;
  if (Math.abs(leftMs - rightMs) > 3 * DAY_MS) return false;

  const overlapRaw = overlapCount(left.tokens, right.tokens);
  const overlap = overlapCoefficient(left.tokens, right.tokens);
  if (overlap >= 0.6) return true;
  if (overlap >= 0.45 && overlapRaw >= 3) return true;

  const leftText = left.tokens.join(' ');
  const rightText = right.tokens.join(' ');
  return leftText.length > 0 && rightText.length > 0 && (leftText.includes(rightText) || rightText.includes(leftText));
}

function createDisjointSet(size: number): { find: (value: number) => number; union: (left: number, right: number) => void } {
  const parent = Array.from({ length: size }, (_, index) => index);

  const find = (value: number): number => {
    if (parent[value] !== value) {
      parent[value] = find(parent[value]!);
    }
    return parent[value]!;
  };

  const union = (left: number, right: number): void => {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft !== rootRight) {
      parent[rootRight] = rootLeft;
    }
  };

  return { find, union };
}

function buildCanonicalTitle(features: IntelFeatures[]): string {
  const counts = new Map<string, number>();
  for (const feature of features) {
    for (const token of feature.tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  const selected = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([token]) => token);

  return selected.join(' ');
}

function buildCandidate(features: IntelFeatures[]): ExtractedEventCandidate {
  const sorted = [...features].sort(
    (left, right) =>
      Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
      left.item.title.localeCompare(right.item.title) ||
      left.item.id.localeCompare(right.item.id)
  );
  const canonicalTitle = buildCanonicalTitle(sorted);
  const occurredAt = sorted[0]?.occurredAt ?? new Date().toISOString();
  const domain = sorted[0]?.domain ?? 'macro';
  const intel = sorted.map((feature) => feature.item);
  const sourceIntelIds = intel.map((item) => item.id).sort();
  const tags = inferTags(intel);

  return {
    eventKey: buildEventKey(canonicalTitle, occurredAt, domain),
    canonicalTitle,
    domain,
    occurredAt,
    sourceIntelIds,
    tags,
    intel,
  };
}

export function extractEventCandidates(items: StoredIntel[]): ExtractedEventCandidate[] {
  const features = items
    .filter((item) => item.title && item.timestamp)
    .map(toFeature)
    .sort(
      (left, right) =>
        Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
        left.item.title.localeCompare(right.item.title) ||
        left.item.id.localeCompare(right.item.id)
    );

  if (features.length === 0) return [];

  const disjoint = createDisjointSet(features.length);
  for (let left = 0; left < features.length; left += 1) {
    for (let right = left + 1; right < features.length; right += 1) {
      if (shouldMerge(features[left]!, features[right]!)) {
        disjoint.union(left, right);
      }
    }
  }

  const clusters = new Map<number, IntelFeatures[]>();
  features.forEach((feature, index) => {
    const root = disjoint.find(index);
    const bucket = clusters.get(root) ?? [];
    bucket.push(feature);
    clusters.set(root, bucket);
  });

  return [...clusters.values()]
    .map(buildCandidate)
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventKey.localeCompare(right.eventKey));
}

export function extractAndStoreEvents(items: StoredIntel[]): NormalizedEvent[] {
  return extractEventCandidates(items).map((candidate) =>
    upsertEvent({
      title: candidate.canonicalTitle,
      domain: candidate.domain,
      occurredAt: candidate.occurredAt,
      sourceIntelIds: candidate.sourceIntelIds,
      tags: candidate.tags,
      status: 'active',
    })
  );
}

export function extractRecentIntelEvents(limit = 25): NormalizedEvent[] {
  return extractAndStoreEvents(listRecentIntel(limit));
}

export function extractEventsFromIntel(items: StoredIntel[]): EventExtractionResult {
  const candidates = extractEventCandidates(items);
  if (candidates.length === 0) {
    return {
      events: [],
      gaps: [
        {
          kind: 'no_material_signals',
          message: 'No material event candidates extracted from current intel set.',
        },
      ],
    };
  }

  return {
    events: candidates.flatMap((candidate) => {
      try {
        return [
          {
            event: upsertEvent({
              title: candidate.canonicalTitle,
              domain: candidate.domain,
              occurredAt: candidate.occurredAt,
              sourceIntelIds: candidate.sourceIntelIds,
              tags: candidate.tags,
              status: 'active',
            }),
            sourceIntel: candidate.intel,
          },
        ];
      } catch {
        return [];
      }
    }),
    gaps: [],
  };
}
