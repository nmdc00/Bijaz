import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HistoricalCaseSource {
  title: string;
  publisher?: string | null;
  url?: string | null;
  source_date?: string | null;
  source_type?: string | null;
}

export interface HistoricalEventCase {
  case_key: string;
  event_date: string;
  event_type: string;
  title: string;
  summary: string;
  domain: string;
  actors: string[];
  locations: string[];
  channels: string[];
  first_order_assets: string[];
  second_order_assets: string[];
  mechanism: string;
  causal_chain: string[];
  forecast: {
    direction: string;
    horizons: string[];
    confidence?: string;
    note?: string;
  };
  outcome: {
    direction_correct: boolean;
    realized_note: string;
    chart_note?: string | null;
    priced_in_note?: string | null;
    reversal_note?: string | null;
  };
  regime_tags: string[];
  sources: HistoricalCaseSource[];
  validation_status: string;
}

const CASE_FILES = [
  'commodities-demand.json',
  'commodities-infrastructure.json',
  'commodities-supply-policy.json',
  'commodities-weather.json',
  'macro-central-banks.json',
  'macro-fx-em.json',
  'macro-inflation-regime.json',
  'macro-sovereign.json',
  'macro-trade-geopolitical.json',
  'metals-mining.json',
  'shipping-chokepoints.json',
  'agri-proteins-disease.json',
  'energy-transition-metals.json',
  'fx-em-asia.json',
  'fx-em-latam-emea.json',
  'shipping-freight-logistics.json',
] as const;

function fixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../../fixtures/historical_event_cases');
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

export function validateHistoricalCase(input: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['case must be an object'] };
  }
  const value = input as Record<string, unknown>;
  const requiredStrings = ['case_key', 'event_date', 'event_type', 'title', 'summary', 'domain', 'mechanism', 'validation_status'];
  for (const key of requiredStrings) {
    if (typeof value[key] !== 'string' || String(value[key]).trim().length === 0) {
      errors.push(`${key} must be a non-empty string`);
    }
  }

  if (asStringArray(value.actors).length === 0) errors.push('actors must be a non-empty array');
  if (asStringArray(value.locations).length === 0) errors.push('locations must be a non-empty array');
  if (asStringArray(value.channels).length === 0) errors.push('channels must be a non-empty array');
  if (asStringArray(value.first_order_assets).length === 0) errors.push('first_order_assets must be a non-empty array');
  if (asStringArray(value.causal_chain).length < 2) errors.push('causal_chain must contain at least 2 steps');
  if (!value.forecast || typeof value.forecast !== 'object') errors.push('forecast must be an object');
  if (!value.outcome || typeof value.outcome !== 'object') errors.push('outcome must be an object');

  return { valid: errors.length === 0, errors };
}

export function loadHistoricalEventCases(): HistoricalEventCase[] {
  const baseDir = fixturesDir();
  const cases: HistoricalEventCase[] = [];

  for (const file of CASE_FILES) {
    const parsed = JSON.parse(readFileSync(join(baseDir, file), 'utf8')) as unknown[];
    for (const entry of parsed) {
      const validation = validateHistoricalCase(entry);
      if (!validation.valid) {
        throw new Error(`Invalid historical case in ${file}: ${validation.errors.join('; ')}`);
      }
      cases.push(entry as HistoricalEventCase);
    }
  }

  return cases.sort((left, right) => left.event_date.localeCompare(right.event_date) || left.case_key.localeCompare(right.case_key));
}

export function searchHistoricalCases(params: {
  domain?: string;
  tags?: string[];
  mechanismQuery?: string;
  limit?: number;
}): HistoricalEventCase[] {
  const domain = params.domain?.trim().toLowerCase();
  const tags = (params.tags ?? []).map((tag) => tag.toLowerCase());
  const mechanismQuery = params.mechanismQuery?.trim().toLowerCase();
  const limit = Math.max(1, params.limit ?? 10);

  return loadHistoricalEventCases()
    .map((entry) => {
      let score = 0;
      if (domain && entry.domain.toLowerCase() === domain) score += 3;
      if (mechanismQuery && entry.mechanism.toLowerCase().includes(mechanismQuery)) score += 3;
      if (mechanismQuery && entry.causal_chain.some((step) => step.toLowerCase().includes(mechanismQuery))) score += 2;
      const tagHits = tags.filter((tag) => entry.regime_tags.map((item) => item.toLowerCase()).includes(tag));
      score += tagHits.length * 2;
      return { entry, score };
    })
    .filter((row) => row.score > 0 || (!domain && !mechanismQuery && tags.length === 0))
    .sort((left, right) => right.score - left.score || left.entry.event_date.localeCompare(right.entry.event_date))
    .slice(0, limit)
    .map((row) => row.entry);
}
