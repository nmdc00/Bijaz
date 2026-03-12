import type { StoredIntel } from '../intel/store.js';
import {
  getLatestThought,
  insertForecast,
  insertThought,
  listForecastsForEvent,
} from '../memory/events.js';
import type {
  EventForecast,
  EventThought,
  EventThoughtInput,
  ForecastDirection,
  ImpactedAsset,
  NormalizedEvent,
} from './types.js';

function buildMechanism(event: NormalizedEvent): string {
  if (event.domain === 'energy') {
    if (event.tags.includes('shipping_disruption') || event.tags.includes('geopolitical_conflict')) {
      return 'Energy supply disruption raises prompt crude risk premium and tightens nearby pricing.';
    }
    if (event.tags.includes('supply_shock')) {
      return 'Supply-side constraint reduces expected availability and supports higher oil pricing.';
    }
    return 'Energy-specific event changes supply-demand expectations and reprices oil-linked contracts.';
  }
  if (event.domain === 'metals') {
    return 'Safe-haven or supply pressure shifts investor demand toward precious metals.';
  }
  if (event.domain === 'agri') {
    return 'Agricultural supply shock changes expected harvest availability and reprices related commodities.';
  }
  if (event.domain === 'macro') {
    return 'Macro regime change alters discount rates, growth expectations, and cross-asset positioning.';
  }
  return 'Market-relevant event changes expectations for the impacted assets.';
}

function buildCausalChain(event: NormalizedEvent): string[] {
  if (event.domain === 'energy') {
    return [
      event.title,
      'Physical supply or shipping risk increases near-term scarcity expectations.',
      'Oil-linked contracts reprice higher if disruption risk persists.',
    ];
  }
  if (event.domain === 'metals') {
    return [event.title, 'Investors seek defensive exposure.', 'Precious metals absorb safe-haven flow.'];
  }
  if (event.domain === 'agri') {
    return [event.title, 'Expected crop supply falls.', 'Food and agricultural futures reprice.'];
  }
  return [event.title, 'Market expectations shift.', 'Impacted assets reprice in line with the new regime.'];
}

function inferImpactedAssets(event: NormalizedEvent, intelItems: StoredIntel[]): ImpactedAsset[] {
  const text = `${event.title}\n${intelItems.map((item) => item.content ?? '').join('\n')}`;
  if (event.domain === 'energy') {
    const assets: ImpactedAsset[] = [
      { symbol: 'CL', direction: 'up', confidence: 0.82 },
      { symbol: 'BRENTOIL', direction: 'up', confidence: 0.78 },
    ];
    if (/\bgold|safe haven|war|iran|hormuz\b/i.test(text)) {
      assets.push({ symbol: 'GOLD', direction: 'up', confidence: 0.68 });
    }
    return assets;
  }
  if (event.domain === 'metals') {
    return [{ symbol: 'GOLD', direction: 'up', confidence: 0.75 }];
  }
  if (event.domain === 'agri') {
    if (/\bwheat\b/i.test(text)) return [{ symbol: 'WHEAT', direction: 'up', confidence: 0.85 }];
    if (/\bcorn\b/i.test(text)) return [{ symbol: 'CORN', direction: 'up', confidence: 0.82 }];
    return [{ symbol: 'COFFEE', direction: 'up', confidence: 0.72 }];
  }
  if (event.domain === 'macro') {
    return [{ symbol: 'DXY', direction: 'up', confidence: 0.55 }];
  }
  return [{ symbol: 'BTC', direction: 'neutral', confidence: 0.25 }];
}

function buildInvalidations(event: NormalizedEvent): string[] {
  if (event.domain === 'energy') {
    return [
      'Shipping disruption resolves quickly without material supply loss.',
      'Emergency reserve releases fully offset the risk premium.',
    ];
  }
  return ['Follow-up evidence contradicts the causal mechanism.'];
}

function buildThoughtInput(event: NormalizedEvent, intelItems: StoredIntel[]): EventThoughtInput {
  return {
    eventId: event.id,
    mechanism: buildMechanism(event),
    causalChain: buildCausalChain(event),
    impactedAssets: inferImpactedAssets(event, intelItems),
    invalidationConditions: buildInvalidations(event),
    modelVersion: 'v1.95-deterministic',
  };
}

function sameThought(a: EventThought, b: EventThoughtInput): boolean {
  return (
    a.mechanism === b.mechanism &&
    JSON.stringify(a.causalChain) === JSON.stringify(b.causalChain) &&
    JSON.stringify(a.impactedAssets) === JSON.stringify(b.impactedAssets) &&
    JSON.stringify(a.invalidationConditions) === JSON.stringify(b.invalidationConditions)
  );
}

function forecastDirectionFromAsset(asset: ImpactedAsset): ForecastDirection {
  return asset.direction;
}

function forecastHorizonHours(event: NormalizedEvent): number {
  if (event.domain === 'energy' || event.tags.includes('geopolitical_conflict')) return 72;
  if (event.domain === 'agri') return 168;
  return 48;
}

export function ensureThoughtForEvent(event: NormalizedEvent, intelItems: StoredIntel[]): EventThought {
  const input = buildThoughtInput(event, intelItems);
  const existing = getLatestThought(event.id);
  if (existing && sameThought(existing, input)) {
    return existing;
  }
  return insertThought(input);
}

export function ensureForecastsForThought(event: NormalizedEvent, thought: EventThought): EventForecast[] {
  const existing = listForecastsForEvent(event.id);
  const out: EventForecast[] = [];
  for (const asset of thought.impactedAssets) {
    const duplicate = existing.find(
      (forecast) =>
        forecast.asset === asset.symbol &&
        forecast.direction === forecastDirectionFromAsset(asset) &&
        forecast.status === 'open'
    );
    if (duplicate) {
      out.push(duplicate);
      continue;
    }
    out.push(
      insertForecast({
        eventId: event.id,
        thoughtId: thought.id,
        asset: asset.symbol,
        domain: event.domain,
        direction: forecastDirectionFromAsset(asset),
        horizonHours: forecastHorizonHours(event),
        confidence: asset.confidence,
        invalidationConditions: thought.invalidationConditions,
      })
    );
  }
  return out;
}
