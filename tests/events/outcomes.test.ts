import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('event outcomes', () => {
  beforeEach(() => vi.resetModules());

  it('expires stale forecasts deterministically', async () => {
    const getOutcomeForForecast = vi.fn(() => null);
    const insertOutcome = vi.fn((input) => ({
      id: 'outcome-1',
      forecastId: input.forecastId,
      eventId: input.eventId,
      resolutionStatus: input.resolutionStatus,
      resolutionNote: input.resolutionNote,
      actualDirection: input.actualDirection,
      resolvedAt: '2026-03-12 00:00:00',
      createdAt: '2026-03-12 00:00:00',
    }));
    const listExpiredOpenForecasts = vi.fn(() => [
      {
        id: 'forecast-1',
        eventId: 'evt-1',
      },
    ]);
    const listOpenForecasts = vi.fn(() => []);
    vi.doMock('../../src/memory/events.js', () => ({
      getOutcomeForForecast,
      insertOutcome,
      listExpiredOpenForecasts,
      listOpenForecasts,
    }));

    const { sweepExpiredForecasts } = await import('../../src/events/outcomes.js');
    const result = sweepExpiredForecasts();

    expect(result.expired).toHaveLength(1);
    expect(result.expired[0]?.resolutionStatus).toBe('expired');
  });
});
