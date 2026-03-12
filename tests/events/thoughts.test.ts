import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('event thoughts', () => {
  beforeEach(() => vi.resetModules());

  it('creates an energy thought and forecasts for oil disruption', async () => {
    const getLatestThought = vi.fn(() => null);
    const insertThought = vi.fn((input) => ({
      id: 'thought-1',
      eventId: input.eventId,
      version: 1,
      mechanism: input.mechanism,
      causalChain: input.causalChain,
      impactedAssets: input.impactedAssets,
      invalidationConditions: input.invalidationConditions,
      createdAt: '2026-03-12 00:00:00',
    }));
    const listForecastsForEvent = vi.fn(() => []);
    const insertForecast = vi.fn((input) => ({
      id: `forecast-${input.asset}`,
      eventId: input.eventId,
      thoughtId: input.thoughtId,
      asset: input.asset,
      domain: input.domain,
      direction: input.direction,
      horizonHours: input.horizonHours,
      confidence: input.confidence,
      invalidationConditions: input.invalidationConditions,
      status: 'open',
      expiresAt: '2026-03-15 00:00:00',
      createdAt: '2026-03-12 00:00:00',
    }));
    vi.doMock('../../src/memory/events.js', () => ({
      getLatestThought,
      insertThought,
      listForecastsForEvent,
      insertForecast,
    }));

    const { ensureThoughtForEvent, ensureForecastsForThought } = await import('../../src/events/thoughts.js');
    const event = {
      id: 'evt-1',
      eventKey: 'key',
      title: 'Iran threat raises Strait of Hormuz disruption risk',
      domain: 'energy',
      occurredAt: '2026-03-12T12:00:00Z',
      sourceIntelIds: ['intel-1'],
      tags: ['shipping_disruption', 'geopolitical_conflict'],
      status: 'active',
      createdAt: '2026-03-12 00:00:00',
      updatedAt: '2026-03-12 00:00:00',
    } as const;

    const thought = ensureThoughtForEvent(event, [
      {
        id: 'intel-1',
        title: event.title,
        content: 'Crude shipping risk and safe-haven demand are rising.',
        source: 'web',
        sourceType: 'news',
        timestamp: '2026-03-12T12:00:00Z',
      },
    ]);
    const forecasts = ensureForecastsForThought(event, thought);

    expect(thought.mechanism).toContain('risk premium');
    expect(thought.impactedAssets.map((asset) => asset.symbol)).toContain('CL');
    expect(forecasts.map((forecast) => forecast.asset)).toContain('CL');
    expect(forecasts.map((forecast) => forecast.asset)).toContain('GOLD');
  });
});
