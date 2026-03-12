import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createForecastsFromThought, buildOutcomeForForecast, resolveExpiredForecasts } from '../../src/events/outcomes.js';
import { extractEventCandidates } from '../../src/events/extract.js';
import { generateThoughtForEvent } from '../../src/events/thoughts.js';
import { openDatabase } from '../../src/memory/db.js';
import { getOutcomeForForecast, listExpiredOpenForecasts, listForecastsForEvent, upsertEvent } from '../../src/memory/events.js';
import { storeIntel, type StoredIntel } from '../../src/intel/store.js';

const previousDbPath = process.env.THUFIR_DB_PATH;

function fixtureIntel(): StoredIntel[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(here, 'fixtures/recent-intel-event-clusters.json'), 'utf8')
  ) as StoredIntel[];
}

function createTempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-v195-outcomes-'));
  return join(dir, `${name}.sqlite`);
}

async function createThoughtFixture() {
  const intel = fixtureIntel().filter((item) => item.id === 'intel-3' || item.id === 'intel-4');
  const candidate = extractEventCandidates(intel)[0]!;
  const event = upsertEvent({
    title: candidate.canonicalTitle,
    domain: candidate.domain,
    occurredAt: candidate.occurredAt,
    sourceIntelIds: candidate.sourceIntelIds,
    tags: candidate.tags,
  });

  const llm = {
    meta: { provider: 'openai' as const, model: 'test-thought-llm', kind: 'primary' as const },
    async complete() {
      return {
        model: 'test-thought-llm',
        content: JSON.stringify({
          mechanism: 'Oil infrastructure damage tightens crude supply.',
          causalChain: [
            'attack damages processing assets',
            'available supply falls',
            'oil prices rise',
          ],
          firstOrderAssets: ['CL', 'BRENTOIL'],
          expectedDirectionByAsset: {
            CL: 'up',
            BRENTOIL: 'up',
          },
          disconfirmingConditions: ['production returns quickly'],
          confidence: 0.76,
        }),
      };
    },
  };

  const thought = await generateThoughtForEvent({} as any, {
    event,
    intel,
    llm,
  });
  return { event, thought: thought!, intel };
}

afterEach(() => {
  process.env.THUFIR_DB_PATH = previousDbPath;
});

describe('createForecastsFromThought', () => {
  it('creates forecasts across configured horizons for each impacted asset', async () => {
    process.env.THUFIR_DB_PATH = createTempDbPath('forecast-create');
    openDatabase();
    const { event, thought } = await createThoughtFixture();

    const forecasts = createForecastsFromThought(thought, { horizonHours: [24, 72] });

    expect(forecasts).toHaveLength(4);
    expect(forecasts.every((forecast) => forecast.status === 'open')).toBe(true);
    expect(listForecastsForEvent(event.id)).toHaveLength(4);
  });
});

describe('buildOutcomeForForecast', () => {
  it('marks a forecast confirmed when realized move matches direction', () => {
    const outcome = buildOutcomeForForecast({
      forecast: {
        id: 'fc-1',
        eventId: 'evt-1',
        thoughtId: 'th-1',
        asset: 'CL',
        domain: 'energy',
        direction: 'up',
        horizonHours: 24,
        confidence: 0.7,
        invalidationConditions: [],
        status: 'open',
        expiresAt: '2026-03-13T00:00:00Z',
        createdAt: '2026-03-12T00:00:00Z',
      },
      snapshot: {
        startPrice: 70,
        endPrice: 74,
      },
    });

    expect(outcome.resolutionStatus).toBe('confirmed');
    expect(outcome.actualDirection).toBe('up');
  });
});

describe('resolveExpiredForecasts integration', () => {
  it('persists outcomes for due forecasts and closes them out', async () => {
    process.env.THUFIR_DB_PATH = createTempDbPath('forecast-resolve');
    openDatabase();

    for (const item of fixtureIntel().filter((entry) => entry.id === 'intel-3' || entry.id === 'intel-4')) {
      storeIntel(item);
    }

    const { thought } = await createThoughtFixture();
    const created = createForecastsFromThought(thought, { horizonHours: [1] });
    expect(created).toHaveLength(2);

    // Force them due for resolution
    const db = openDatabase();
    db.prepare(`UPDATE event_forecasts SET expires_at = datetime('now', '-1 hour')`).run();
    expect(listExpiredOpenForecasts()).toHaveLength(2);

    const batch = await resolveExpiredForecasts({
      async resolveMove(forecast) {
        return {
          startPrice: forecast.asset === 'CL' ? 70 : 72,
          endPrice: forecast.asset === 'CL' ? 73 : 75,
          note: `Resolved ${forecast.asset}`,
        };
      },
    });

    expect(batch.checked).toBe(2);
    expect(batch.resolved).toBe(2);
    for (const forecast of created) {
      const outcome = getOutcomeForForecast(forecast.id);
      expect(outcome?.resolutionStatus).toBe('confirmed');
      expect(outcome?.actualDirection).toBe('up');
    }
  });
});
