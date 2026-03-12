import type { StoredIntel } from '../intel/store.js';
import { upsertEvent } from '../memory/events.js';
import type { NormalizedEvent } from './types.js';
import { inferMarketContextDomain } from '../markets/context.js';

export interface EventExtractionGap {
  intelId: string | null;
  reason: 'no_intel' | 'unknown_domain' | 'insufficient_signal';
  detail: string;
}

export interface ExtractedEventArtifact {
  event: NormalizedEvent;
  sourceIntel: StoredIntel[];
}

export interface EventExtractionResult {
  events: ExtractedEventArtifact[];
  gaps: EventExtractionGap[];
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

function inferTags(text: string): string[] {
  const tags = new Set<string>();
  if (/\biran|hormuz|abqaiq|pipeline|tanker|shipping\b/i.test(text)) tags.add('shipping_disruption');
  if (/\bopec|production cut|output cut|sanction|embargo\b/i.test(text)) tags.add('supply_shock');
  if (/\bwar|strike|attack|conflict|missile|drone\b/i.test(text)) tags.add('geopolitical_conflict');
  if (/\bgold|safe haven\b/i.test(text)) tags.add('safe_haven_flow');
  if (/\bdrought|frost|crop|harvest|export ban\b/i.test(text)) tags.add('agri_supply_shock');
  if (/\bcpi|inflation|gdp|fed|rates\b/i.test(text)) tags.add('macro_regime_shift');
  return Array.from(tags);
}

function isMaterialSignal(title: string, content?: string): boolean {
  const text = `${title}\n${content ?? ''}`;
  return /\b(cut|attack|strike|ban|sanction|embargo|disruption|closure|war|missile|surge|halt|reserve release)\b/i.test(
    text
  );
}

export function extractEventsFromIntel(items: StoredIntel[]): EventExtractionResult {
  if (items.length === 0) {
    return {
      events: [],
      gaps: [{ intelId: null, reason: 'no_intel', detail: 'No intel items available for extraction.' }],
    };
  }

  const grouped = new Map<string, StoredIntel[]>();
  const gaps: EventExtractionGap[] = [];

  for (const item of items) {
    const title = normalizeTitle(item.title);
    const text = `${title}\n${item.content ?? ''}`;
    const domain = inferMarketContextDomain(text);
    if (domain === 'other') {
      gaps.push({
        intelId: item.id,
        reason: 'unknown_domain',
        detail: `Could not map intel item "${title}" to a supported market domain.`,
      });
      continue;
    }
    if (!isMaterialSignal(title, item.content)) {
      gaps.push({
        intelId: item.id,
        reason: 'insufficient_signal',
        detail: `Intel item "${title}" did not contain a strong event trigger.`,
      });
      continue;
    }

    const key = `${domain}:${title.toLowerCase()}:${item.timestamp.slice(0, 10)}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  }

  const events: ExtractedEventArtifact[] = [];
  for (const bucket of grouped.values()) {
    const primary = bucket[0]!;
    const title = normalizeTitle(primary.title);
    const text = `${title}\n${primary.content ?? ''}`;
    const domain = inferMarketContextDomain(text);
    const tags = Array.from(new Set(bucket.flatMap((item) => inferTags(`${item.title}\n${item.content ?? ''}`))));
    const event = upsertEvent({
      title,
      domain,
      occurredAt: primary.timestamp,
      sourceIntelIds: bucket.map((item) => item.id),
      tags,
    });
    events.push({ event, sourceIntel: bucket });
  }

  return { events, gaps };
}
