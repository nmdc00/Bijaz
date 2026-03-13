import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadHistoricalEventCases, searchHistoricalCases } from '../../src/events/casebase.js';
import { extractAndStoreEvents } from '../../src/events/extract.js';
import { createForecastsFromThought, resolveExpiredForecasts } from '../../src/events/outcomes.js';
import { generateThoughtForEvent } from '../../src/events/thoughts.js';
import { openDatabase } from '../../src/memory/db.js';
import { getOutcomeForForecast, listEvents, listForecastsForEvent, listOutcomesForEvent } from '../../src/memory/events.js';
import { storeIntel, type StoredIntel } from '../../src/intel/store.js';

const previousDbPath = process.env.THUFIR_DB_PATH;

function fixtureIntel(): StoredIntel[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(here, '../events/fixtures/recent-intel-event-clusters.json'), 'utf8')
  ) as StoredIntel[];
}

function createTempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-v195-acceptance-'));
  return join(dir, `${name}.sqlite`);
}

afterEach(() => {
  process.env.THUFIR_DB_PATH = previousDbPath;
});

describe('v1.95 causal event pipeline acceptance', () => {
  it('runs intel -> event -> thought -> forecast -> outcome chain with historical case retrieval', async () => {
    process.env.THUFIR_DB_PATH = createTempDbPath('event-pipeline');
    openDatabase();

    const intel = fixtureIntel().filter((item) => item.id === 'intel-3' || item.id === 'intel-4');
    intel.forEach((item) => expect(storeIntel(item)).toBe(true));

    const events = extractAndStoreEvents(intel);
    expect(events).toHaveLength(1);

    const event = events[0]!;
    const historicalCases = searchHistoricalCases({
      domain: event.domain,
      tags: event.tags,
      mechanismQuery: 'supply',
      limit: 3,
    });
    expect(historicalCases.length).toBeGreaterThan(0);
    expect(loadHistoricalEventCases().length).toBeGreaterThanOrEqual(150);

    const thought = await generateThoughtForEvent({} as any, {
      event,
      intel,
      llm: {
        meta: { provider: 'openai', model: 'test-thought', kind: 'primary' },
        async complete() {
          return {
            model: 'test-thought',
            content: JSON.stringify({
              mechanism: 'Processing disruption tightens near-term crude supply and raises benchmark prices.',
              causalChain: [
                'attack damages infrastructure',
                'available crude supply falls',
                'benchmark prices rise',
              ],
              firstOrderAssets: ['CL', 'BRENTOIL'],
              expectedDirectionByAsset: { CL: 'up', BRENTOIL: 'up' },
              disconfirmingConditions: ['facilities restart quickly'],
              confidence: 0.8,
            }),
          };
        },
      } as any,
    });
    expect(thought).not.toBeNull();

    const forecasts = createForecastsFromThought(thought!, { horizonHours: [1] });
    expect(forecasts.length).toBe(2);
    expect(listForecastsForEvent(event.id)).toHaveLength(2);

    const db = openDatabase();
    db.prepare(`UPDATE event_forecasts SET expires_at = datetime('now', '-1 hour')`).run();

    const resolved = await resolveExpiredForecasts({
      async resolveMove(forecast) {
        return {
          startPrice: forecast.asset === 'CL' ? 70 : 72,
          endPrice: forecast.asset === 'CL' ? 73 : 75,
          note: `Resolved ${forecast.asset}`,
        };
      },
    });

    expect(resolved.resolved).toBe(2);
    expect(listEvents({ domain: 'energy', limit: 5 })).toHaveLength(1);
    expect(listOutcomesForEvent(event.id)).toHaveLength(2);
    for (const forecast of forecasts) {
      const outcome = getOutcomeForForecast(forecast.id);
      expect(outcome?.resolutionStatus).toBe('confirmed');
    }
  });
});
