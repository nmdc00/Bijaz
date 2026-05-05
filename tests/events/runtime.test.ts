import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractAndStoreEvents } from '../../src/events/extract.js';
import {
  materializeThoughtsAndForecastsForEvents,
  resolveForecastMoveWithPriceService,
} from '../../src/events/runtime.js';
import { openDatabase } from '../../src/memory/db.js';
import { listForecastsForEvent, listThoughtsForEvent } from '../../src/memory/events.js';
import { storeIntel, type StoredIntel } from '../../src/intel/store.js';

const previousDbPath = process.env.THUFIR_DB_PATH;

function fixtureIntel(): StoredIntel[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(here, './fixtures/recent-intel-event-clusters.json'), 'utf8')
  ) as StoredIntel[];
}

function createTempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-v195-runtime-'));
  return join(dir, `${name}.sqlite`);
}

describe('v1.95 runtime helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.THUFIR_DB_PATH = previousDbPath;
  });

  it('materializes thoughts and forecasts once for extracted events', async () => {
    process.env.THUFIR_DB_PATH = createTempDbPath('materialize');
    openDatabase();

    const intel = fixtureIntel().filter((item) => item.id === 'intel-3' || item.id === 'intel-4');
    intel.forEach((item) => expect(storeIntel(item)).toBe(true));
    const events = extractAndStoreEvents(intel);

    const llm = {
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
    } as any;

    const first = await materializeThoughtsAndForecastsForEvents({} as any, events, {
      llm,
      horizonHours: [24],
    });
    const second = await materializeThoughtsAndForecastsForEvents({} as any, events, {
      llm,
      horizonHours: [24],
    });

    expect(first.thoughtsCreated).toBe(1);
    expect(first.forecastsCreated).toBe(2);
    expect(listThoughtsForEvent(events[0]!.id)).toHaveLength(1);
    expect(listForecastsForEvent(events[0]!.id)).toHaveLength(2);
    expect(second.thoughtsCreated).toBe(0);
    expect(second.forecastsCreated).toBe(0);
  });

  it('resolves forecast moves from candle history via injected price service', async () => {
    const snapshot = await resolveForecastMoveWithPriceService(
      {} as any,
      {
        id: 'forecast-1',
        eventId: 'event-1',
        thoughtId: 'thought-1',
        asset: 'BTC',
        domain: 'crypto',
        direction: 'up',
        horizonHours: 24,
        confidence: 0.7,
        invalidationConditions: [],
        status: 'open',
        createdAt: '2026-05-01T00:00:00.000Z',
        expiresAt: '2026-05-02T00:00:00.000Z',
      },
      {
        supportsSymbol: vi.fn().mockResolvedValue(true),
        getCandles: vi.fn().mockResolvedValue([
          { timestamp: Date.parse('2026-05-01T00:00:00.000Z'), close: 100 },
          { timestamp: Date.parse('2026-05-01T12:00:00.000Z'), close: 105 },
          { timestamp: Date.parse('2026-05-02T00:00:00.000Z'), close: 112 },
        ]),
      } as any
    );

    expect(snapshot?.startPrice).toBe(100);
    expect(snapshot?.endPrice).toBe(112);
    expect(snapshot?.note).toMatch(/candles/i);
  });
});
