export interface IntelAlertConfig {
  watchlistOnly?: boolean;
  maxItems?: number;
  includeSources?: string[];
  excludeSources?: string[];
  includeKeywords?: string[];
  excludeKeywords?: string[];
  minKeywordOverlap?: number;
  minTitleLength?: number;
  minSentiment?: number;
  maxSentiment?: number;
  sentimentPreset?: 'any' | 'positive' | 'negative' | 'neutral';
  includeEntities?: string[];
  excludeEntities?: string[];
  minEntityOverlap?: number;
  useContent?: boolean;
  minScore?: number;
  keywordWeight?: number;
  entityWeight?: number;
  sentimentWeight?: number;
  positiveSentimentThreshold?: number;
  negativeSentimentThreshold?: number;
  showScore?: boolean;
  showReasons?: boolean;
  entityAliases?: Record<string, string[]>;
}

export interface IntelAlertItem {
  title: string;
  source: string;
  url?: string;
  content?: string;
}

export function filterIntelAlerts(
  items: IntelAlertItem[],
  config: IntelAlertConfig,
  watchlistTitles: string[]
): string[] {
  return rankIntelAlerts(items, config, watchlistTitles).map((item) => item.text);
}

function normalizeConfig(config: IntelAlertConfig) {
  const preset = config.sentimentPreset ?? 'any';
  const minScore =
    config.minScore !== undefined
      ? config.minScore
      : preset === 'negative'
        ? -Infinity
        : 0;

  return {
    watchlistOnly: config.watchlistOnly ?? true,
    maxItems: config.maxItems ?? 10,
    includeSources: config.includeSources ?? [],
    excludeSources: config.excludeSources ?? [],
    includeKeywords: config.includeKeywords ?? [],
    excludeKeywords: config.excludeKeywords ?? [],
    minKeywordOverlap: config.minKeywordOverlap ?? 1,
    minTitleLength: config.minTitleLength ?? 8,
    minSentiment: config.minSentiment ?? null,
    maxSentiment: config.maxSentiment ?? null,
    sentimentPreset: preset,
    positiveSentimentThreshold: config.positiveSentimentThreshold ?? 0.05,
    negativeSentimentThreshold: config.negativeSentimentThreshold ?? -0.05,
    includeEntities: config.includeEntities ?? [],
    excludeEntities: config.excludeEntities ?? [],
    minEntityOverlap: config.minEntityOverlap ?? 1,
    useContent: config.useContent ?? true,
    minScore,
    keywordWeight: config.keywordWeight ?? 1,
    entityWeight: config.entityWeight ?? 1,
    sentimentWeight: config.sentimentWeight ?? 1,
    showScore: config.showScore ?? false,
    showReasons: config.showReasons ?? false,
    entityAliases: config.entityAliases ?? {},
  };
}

function keywordOverlap(a: string, b: string): number {
  const tokens = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4);
  const setA = new Set(tokens(a));
  const setB = new Set(tokens(b));
  let count = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      count += 1;
    }
  }
  return count;
}

function containsAny(text: string, keywords: string[]): boolean {
  const lowered = text.toLowerCase();
  return keywords.some((word) => lowered.includes(word.toLowerCase()));
}

function buildText(item: IntelAlertItem, useContent: boolean): string {
  if (useContent && item.content) {
    return `${item.title}\n${item.content}`;
  }
  return item.title;
}

function extractEntities(text: string): string[] {
  const cleaned = text.replace(/[^\w\s'-]/g, ' ');
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const entities: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const phrase = current.join(' ');
    if (phrase.length >= 3) {
      entities.push(phrase);
    }
    current = [];
  };

  for (const token of tokens) {
    const isAcronym = token.length >= 2 && token === token.toUpperCase();
    const isCapitalized = token.length > 1 && token[0] === token[0]?.toUpperCase();
    const isNumber = /^\d{2,}$/.test(token);

    if (isAcronym || isCapitalized) {
      current.push(token);
      continue;
    }
    if (isNumber && current.length > 0) {
      current.push(token);
      continue;
    }
    flush();
  }
  flush();

  return Array.from(new Set(entities));
}

function overlapCount(a: string[], b: string[]): number {
  let count = 0;
  for (const item of a) {
    const lowerA = item.toLowerCase();
    for (const target of b) {
      const lowerB = target.toLowerCase();
      if (lowerA === lowerB || lowerA.includes(lowerB) || lowerB.includes(lowerA)) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

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

export function rankIntelAlerts(
  items: IntelAlertItem[],
  config: IntelAlertConfig,
  watchlistTitles: string[]
): Array<{ text: string; score: number }> {
  const settings = normalizeConfig(config);
  const ranked: Array<{ text: string; score: number }> = [];

  for (const intel of items) {
    const text = buildText(intel, settings.useContent);

    if (settings.minTitleLength > 0 && intel.title.length < settings.minTitleLength) {
      continue;
    }
    if (settings.includeSources.length > 0 && !settings.includeSources.includes(intel.source)) {
      continue;
    }
    if (settings.excludeSources.length > 0 && settings.excludeSources.includes(intel.source)) {
      continue;
    }
    if (settings.includeKeywords.length > 0 && !containsAny(text, settings.includeKeywords)) {
      continue;
    }
    if (settings.excludeKeywords.length > 0 && containsAny(text, settings.excludeKeywords)) {
      continue;
    }

    let keywordScore = 0;
    if (settings.watchlistOnly && watchlistTitles.length > 0) {
      const maxOverlap = Math.max(
        0,
        ...watchlistTitles.map((title) => keywordOverlap(text, title))
      );
      if (maxOverlap < settings.minKeywordOverlap) {
        continue;
      }
      keywordScore += maxOverlap;
    } else if (settings.includeKeywords.length > 0) {
      keywordScore += overlapCount(extractEntities(text), settings.includeKeywords);
    }

    let entityScore = 0;
    const entities = extractEntities(text);
    const expandedEntities = expandEntities(entities, settings.entityAliases);
    const targetIncludeEntities = expandEntities(
      settings.includeEntities,
      settings.entityAliases
    );
    const targetExcludeEntities = expandEntities(
      settings.excludeEntities,
      settings.entityAliases
    );

    if (targetIncludeEntities.length > 0) {
      const count = overlapCount(expandedEntities, targetIncludeEntities);
      if (count < settings.minEntityOverlap) {
        continue;
      }
      entityScore += count;
    }
    if (targetExcludeEntities.length > 0) {
      const count = overlapCount(expandedEntities, targetExcludeEntities);
      if (count > 0) {
        continue;
      }
    }

    const sentiment = scoreSentiment(text);
    const preset = settings.sentimentPreset;
    if (preset === 'positive' && sentiment < settings.positiveSentimentThreshold) {
      continue;
    }
    if (preset === 'negative' && sentiment > settings.negativeSentimentThreshold) {
      continue;
    }
    if (
      preset === 'neutral' &&
      (sentiment < settings.negativeSentimentThreshold ||
        sentiment > settings.positiveSentimentThreshold)
    ) {
      continue;
    }
    if (settings.minSentiment !== null && sentiment < settings.minSentiment) {
      continue;
    }
    if (settings.maxSentiment !== null && sentiment > settings.maxSentiment) {
      continue;
    }

    const score =
      keywordScore * settings.keywordWeight +
      entityScore * settings.entityWeight +
      sentiment * settings.sentimentWeight;

    if (score < settings.minScore) {
      continue;
    }

    const link = intel.url ? `\n${intel.url}` : '';
    const scoreSuffix = settings.showScore ? ` [score: ${score.toFixed(2)}]` : '';
    const reasonsSuffix = settings.showReasons
      ? buildReasons({
          keywordScore,
          entityScore,
          sentiment,
          entities: expandedEntities,
          includeKeywords: settings.includeKeywords,
          includeEntities: targetIncludeEntities,
        })
      : '';
    ranked.push({
      text: `• ${intel.title} (${intel.source})${scoreSuffix}${reasonsSuffix}${link}`,
      score,
    });
  }

  return ranked.sort((a, b) => b.score - a.score).slice(0, settings.maxItems);
}

function expandEntities(items: string[], aliases: Record<string, string[]>): string[] {
  const expanded: string[] = [];
  for (const item of items) {
    expanded.push(item);
    const mapped = aliases[item];
    if (mapped) {
      expanded.push(...mapped);
    }
  }
  return Array.from(new Set(expanded));
}

function buildReasons(params: {
  keywordScore: number;
  entityScore: number;
  sentiment: number;
  entities: string[];
  includeKeywords: string[];
  includeEntities: string[];
}): string {
  const reasons: string[] = [];
  if (params.keywordScore > 0) {
    reasons.push(`kw=${params.keywordScore}`);
  }
  if (params.entityScore > 0) {
    reasons.push(`ent=${params.entityScore}`);
  }
  if (params.sentiment !== 0) {
    reasons.push(`sent=${params.sentiment.toFixed(2)}`);
  }
  if (params.includeEntities.length > 0) {
    const matched = params.includeEntities.filter((e) =>
      params.entities.some((ent) => ent.toLowerCase().includes(e.toLowerCase()))
    );
    if (matched.length > 0) {
      reasons.push(`match=${matched.slice(0, 3).join(',')}`);
    }
  }
  return reasons.length > 0 ? ` [${reasons.join(' ')}]` : '';
}
