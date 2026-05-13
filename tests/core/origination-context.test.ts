import { describe, expect, it, vi } from 'vitest';

import { buildOriginationEventContext, resolveOriginationContextDomain } from '../../src/core/origination_context.js';

describe('origination_context', () => {
  it('prefers commodity domains when recent events align with top markets', () => {
    const domain = resolveOriginationContextDomain(
      ['BTC', 'ETH', 'XYZ:CL', 'XYZ:GOLD'],
      [
        {
          id: 'event-1',
          eventKey: 'event-key-1',
          title: 'Hormuz disruption tightens crude exports',
          domain: 'energy',
          occurredAt: new Date().toISOString(),
          sourceIntelIds: [],
          tags: ['supply_shock'],
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]
    );

    expect(domain).toBe('energy');
  });

  it('builds compact event intelligence from existing thought, forecast, outcome, and case artifacts', () => {
    const context = buildOriginationEventContext({
      topMarkets: ['XYZ:CL', 'XYZ:GOLD'],
      focusDomain: 'energy',
      recentEvents: [
        {
          id: 'event-1',
          eventKey: 'event-key-1',
          title: 'Hormuz disruption tightens crude exports',
          domain: 'energy',
          occurredAt: new Date().toISOString(),
          sourceIntelIds: [],
          tags: ['supply_shock', 'attack'],
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      getLatestThought: vi.fn(() => ({
        id: 'thought-1',
        eventId: 'event-1',
        version: 1,
        mechanism: 'Shipping disruption reduces crude availability and lifts front-month oil.',
        causalChain: ['attack disrupts shipping', 'exports fall', 'oil reprices higher'],
        impactedAssets: [{ symbol: 'CL', direction: 'up', confidence: 0.82 }],
        invalidationConditions: ['shipping resumes quickly'],
        createdAt: new Date().toISOString(),
      })),
      listForecastsForEvent: vi.fn(() => [{
        id: 'forecast-1',
        eventId: 'event-1',
        thoughtId: 'thought-1',
        asset: 'CL',
        domain: 'energy',
        direction: 'up',
        horizonHours: 24,
        confidence: 0.82,
        invalidationConditions: ['shipping resumes quickly'],
        status: 'open',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      }]),
      listOutcomesForEvent: vi.fn(() => [{
        id: 'outcome-1',
        forecastId: 'forecast-0',
        eventId: 'event-1',
        resolutionStatus: 'confirmed',
        actualDirection: 'up',
        resolvedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }]),
      searchHistoricalCases: vi.fn(() => [{
        case_key: '2019-abqaiq-attack-oil',
        event_date: '2019-09-14',
        event_type: 'attack',
        title: 'Abqaiq attack disrupts Saudi output',
        summary: 'Oil jumps on supply shock.',
        domain: 'energy',
        actors: ['Saudi Arabia'],
        locations: ['Saudi Arabia'],
        channels: ['shipping'],
        first_order_assets: ['CL'],
        second_order_assets: ['BRENTOIL'],
        mechanism: 'supply outage reprices crude benchmarks higher',
        causal_chain: ['attack', 'output outage', 'oil higher'],
        forecast: { direction: 'up', horizons: ['24h'] },
        outcome: { direction_correct: true, realized_note: 'Oil rallied.' },
        regime_tags: ['supply_shock'],
        sources: [],
        validation_status: 'validated',
      }]),
    });

    expect(context).toContain('Hormuz disruption tightens crude exports');
    expect(context).toContain('Shipping disruption reduces crude availability');
    expect(context).toContain('CL up 24h');
    expect(context).toContain('confirmed=1');
    expect(context).toContain('2019-abqaiq-attack-oil');
  });
});
