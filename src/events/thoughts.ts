import { createLlmClient, type ChatMessage, type LlmClient } from '../core/llm.js';
import type { ThufirConfig } from '../core/config.js';
import { withExecutionContextIfMissing } from '../core/llm_infra.js';
import { listIntelByIds, type StoredIntel } from '../intel/store.js';
import { getEventById, getLatestThought, insertThought } from '../memory/events.js';
import type { EventThought, EventThoughtInput, ImpactedAsset, NormalizedEvent } from './types.js';
import { validateThoughtInput } from './types.js';

type ThoughtDirection = ImpactedAsset['direction'];

export interface ThoughtDraft {
  mechanism?: unknown;
  causalChain?: unknown;
  impactedAssets?: unknown;
  firstOrderAssets?: unknown;
  expectedDirectionByAsset?: unknown;
  confidence?: unknown;
  invalidationConditions?: unknown;
  disconfirmingConditions?: unknown;
  modelVersion?: unknown;
}

export interface ThoughtMaterialityAssessment {
  material: boolean;
  score: number;
  reasons: string[];
}

export interface GenerateThoughtOptions {
  event: NormalizedEvent;
  intel?: StoredIntel[];
  llm?: LlmClient;
  modelVersion?: string;
  persist?: boolean;
}

const MATERIAL_TAGS = new Set([
  'attack',
  'central_bank',
  'export_ban',
  'inflation',
  'sanctions',
  'supply_shock',
  'weather',
]);

const DOMAIN_ASSET_HINTS: Record<string, string[]> = {
  agri: ['WHEAT', 'CORN', 'SOYBEAN', 'COFFEE'],
  crypto: ['BTC', 'ETH', 'SOL'],
  energy: ['CL', 'BRENTOIL', 'GOLD'],
  equity: ['SPY', 'QQQ'],
  fx: ['DXY', 'EURUSD', 'USDJPY'],
  macro: ['DXY', 'GOLD', 'SPY'],
  metals: ['GOLD', 'SILVER', 'COPPER'],
  rates: ['ZN', 'TLT', 'DXY'],
};

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function parseJsonObject(content: string): ThoughtDraft | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1)) as ThoughtDraft;
  } catch {
    return null;
  }
}

function normalizeDirection(value: unknown): ThoughtDirection {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'up' || raw === 'bullish' || raw === 'higher') return 'up';
  if (raw === 'down' || raw === 'bearish' || raw === 'lower') return 'down';
  return 'neutral';
}

function clampConfidence(value: unknown, fallback = 0.5): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

function assetHintsForEvent(event: NormalizedEvent, intel: StoredIntel[]): string[] {
  const hinted = [...(DOMAIN_ASSET_HINTS[event.domain] ?? [])];
  const haystack = `${event.title}\n${intel.map((item) => `${item.title}\n${item.content ?? ''}`).join('\n')}`.toLowerCase();

  if (haystack.includes('wheat')) hinted.unshift('WHEAT');
  if (haystack.includes('corn')) hinted.unshift('CORN');
  if (haystack.includes('coffee')) hinted.unshift('COFFEE');
  if (haystack.includes('oil') || haystack.includes('crude')) hinted.unshift('CL', 'BRENTOIL');
  if (haystack.includes('gold')) hinted.unshift('GOLD');
  if (haystack.includes('inflation')) hinted.unshift('DXY');

  return Array.from(new Set(hinted)).slice(0, 4);
}

function normalizeImpactedAssets(params: {
  draft: ThoughtDraft;
  event: NormalizedEvent;
  intel: StoredIntel[];
}): ImpactedAsset[] {
  const { draft, event, intel } = params;
  const explicit = Array.isArray(draft.impactedAssets) ? draft.impactedAssets : [];
  const normalizedExplicit = explicit
    .map((asset) => {
      if (!asset || typeof asset !== 'object') return null;
      const obj = asset as Record<string, unknown>;
      const symbol = asString(obj.symbol);
      if (!symbol) return null;
      return {
        symbol: symbol.toUpperCase(),
        direction: normalizeDirection(obj.direction),
        confidence: clampConfidence(obj.confidence, clampConfidence(draft.confidence, 0.5)),
      } satisfies ImpactedAsset;
    })
    .filter((asset): asset is ImpactedAsset => Boolean(asset));
  if (normalizedExplicit.length > 0) {
    return normalizedExplicit;
  }

  const assets = asStringArray(draft.firstOrderAssets).map((asset) => asset.toUpperCase());
  const directionMap =
    draft.expectedDirectionByAsset && typeof draft.expectedDirectionByAsset === 'object'
      ? (draft.expectedDirectionByAsset as Record<string, unknown>)
      : {};
  const confidence = clampConfidence(draft.confidence, 0.5);
  const repaired = assets.map((asset) => ({
    symbol: asset,
    direction: normalizeDirection(directionMap[asset] ?? directionMap[asset.toLowerCase()]),
    confidence,
  }));

  if (repaired.length > 0) {
    return repaired;
  }

  return assetHintsForEvent(event, intel).map((asset) => ({
    symbol: asset,
    direction: 'neutral',
    confidence,
  }));
}

export function assessThoughtMateriality(event: NormalizedEvent, intel: StoredIntel[] = []): ThoughtMaterialityAssessment {
  let score = 0;
  const reasons: string[] = [];

  if (event.sourceIntelIds.length >= 2 || intel.length >= 2) {
    score += 2;
    reasons.push('multiple_sources');
  }
  const materialTags = event.tags.filter((tag) => MATERIAL_TAGS.has(tag));
  if (materialTags.length > 0) {
    score += 2;
    reasons.push(`material_tags:${materialTags.join(',')}`);
  }
  if (intel.some((item) => /ban|attack|strike|shock|cut|inflation|outage|sanction/i.test(`${item.title} ${item.content ?? ''}`))) {
    score += 1;
    reasons.push('shock_language');
  }
  if (DOMAIN_ASSET_HINTS[event.domain]?.length) {
    score += 1;
    reasons.push(`tracked_domain:${event.domain}`);
  }

  return {
    material: score >= 3,
    score,
    reasons,
  };
}

export function coerceThoughtDraft(params: {
  draft: ThoughtDraft;
  event: NormalizedEvent;
  intel?: StoredIntel[];
  modelVersion?: string;
}): EventThoughtInput | null {
  const intel = params.intel ?? [];
  const mechanism = asString(params.draft.mechanism);
  const causalChain = asStringArray(params.draft.causalChain);
  const invalidationConditions = asStringArray(
    params.draft.invalidationConditions ?? params.draft.disconfirmingConditions
  );
  const impactedAssets = normalizeImpactedAssets({
    draft: params.draft,
    event: params.event,
    intel,
  });

  const candidate: EventThoughtInput = {
    eventId: params.event.id,
    mechanism: mechanism ?? '',
    causalChain,
    impactedAssets,
    invalidationConditions,
    modelVersion: asString(params.draft.modelVersion) ?? params.modelVersion,
  };

  const validation = validateThoughtInput(candidate);
  if (!validation.valid) {
    return null;
  }
  return candidate;
}

function renderIntelContext(intel: StoredIntel[]): string {
  return JSON.stringify(
    intel.map((item) => ({
      id: item.id,
      title: item.title,
      source: item.source,
      timestamp: item.timestamp,
      content: item.content ?? '',
    })),
    null,
    2
  );
}

function buildThoughtMessages(event: NormalizedEvent, intel: StoredIntel[]): ChatMessage[] {
  const system = [
    'You generate mechanism-first market thought artifacts for normalized events.',
    'Output ONLY strict JSON. No markdown. No commentary.',
    'Required keys: mechanism, causalChain, firstOrderAssets, expectedDirectionByAsset, disconfirmingConditions, confidence.',
    'Rules: causalChain must contain at least 2 steps; disconfirmingConditions must be non-empty; confidence must be between 0 and 1.',
  ].join('\n');

  const user = JSON.stringify(
    {
      schemaVersion: '1',
      event: {
        id: event.id,
        title: event.title,
        domain: event.domain,
        occurredAt: event.occurredAt,
        tags: event.tags,
        sourceIntelIds: event.sourceIntelIds,
      },
      intel,
      requestedShape: {
        mechanism: 'string',
        causalChain: ['string'],
        firstOrderAssets: ['string'],
        expectedDirectionByAsset: { ASSET: 'up|down|neutral' },
        confidence: 0.0,
        disconfirmingConditions: ['string'],
      },
    },
    null,
    2
  );

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export async function generateThoughtDraft(params: {
  config: ThufirConfig;
  event: NormalizedEvent;
  intel?: StoredIntel[];
  llm?: LlmClient;
}): Promise<ThoughtDraft | null> {
  const intel = params.intel ?? listIntelByIds(params.event.sourceIntelIds);
  const llm = params.llm ?? createLlmClient(params.config);
  const messages = buildThoughtMessages(params.event, intel);

  try {
    const response = await withExecutionContextIfMissing(
      { mode: 'LIGHT_REASONING', critical: false, reason: 'event_thought_generation', source: 'events' },
      () => llm.complete(messages, { temperature: 0.2, maxTokens: 600 })
    );
    return parseJsonObject(response.content);
  } catch {
    return null;
  }
}

export async function generateThoughtForEvent(
  config: ThufirConfig,
  options: GenerateThoughtOptions
): Promise<EventThought | null> {
  const intel = options.intel ?? listIntelByIds(options.event.sourceIntelIds);
  const materiality = assessThoughtMateriality(options.event, intel);
  if (!materiality.material) {
    return null;
  }

  const draft = await generateThoughtDraft({
    config,
    event: options.event,
    intel,
    llm: options.llm,
  });
  if (!draft) {
    return null;
  }

  const normalized = coerceThoughtDraft({
    draft,
    event: options.event,
    intel,
    modelVersion: options.modelVersion ?? options.llm?.meta?.model,
  });
  if (!normalized) {
    return null;
  }

  if (options.persist === false) {
    return {
      id: 'preview',
      eventId: normalized.eventId,
      version: 1,
      mechanism: normalized.mechanism,
      causalChain: normalized.causalChain,
      impactedAssets: normalized.impactedAssets,
      invalidationConditions: normalized.invalidationConditions,
      modelVersion: normalized.modelVersion,
      createdAt: new Date().toISOString(),
    };
  }

  return insertThought(normalized);
}

export async function generateThoughtForEventId(
  config: ThufirConfig,
  eventId: string,
  options?: Omit<GenerateThoughtOptions, 'event'>
): Promise<EventThought | null> {
  const event = getEventById(eventId);
  if (!event) {
    return null;
  }
  return generateThoughtForEvent(config, {
    ...options,
    event,
  });
}

export function ensureThoughtForEvent(event: NormalizedEvent, intel: StoredIntel[]): EventThought {
  const existing = getLatestThought(event.id);
  if (existing) {
    return existing;
  }

  const mechanism = intel[0]?.title ?? event.title;
  return insertThought({
    eventId: event.id,
    mechanism,
    causalChain: [mechanism],
    impactedAssets: [],
    invalidationConditions: [],
    modelVersion: 'compat.ensureThoughtForEvent',
  });
}

export function buildThoughtContextSummary(event: NormalizedEvent, intel?: StoredIntel[]): string {
  const lines = [
    `event: ${event.title}`,
    `domain: ${event.domain}`,
    `occurred_at: ${event.occurredAt}`,
    `tags: ${event.tags.join(', ') || 'none'}`,
    `source_intel_ids: ${event.sourceIntelIds.join(', ') || 'none'}`,
  ];
  if (intel && intel.length > 0) {
    lines.push(`intel: ${renderIntelContext(intel)}`);
  }
  return lines.join('\n');
}
