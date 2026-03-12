import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { executeToolCall } from '../../src/core/tool-executor.js';
import { extractEventCandidates } from '../../src/events/extract.js';
import { createForecastsFromThought } from '../../src/events/outcomes.js';
import { generateThoughtForEvent } from '../../src/events/thoughts.js';
import { openDatabase } from '../../src/memory/db.js';
import { upsertEvent } from '../../src/memory/events.js';

const previousDbPath = process.env.THUFIR_DB_PATH;

function fixtureIntel() {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, '../events/fixtures/recent-intel-event-clusters.json'), 'utf8')) as Array<Record<string, unknown>>;
}

function createTempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-v195-tools-'));
  return join(dir, `${name}.sqlite`);
}

afterEach(() => {
  process.env.THUFIR_DB_PATH = previousDbPath;
});

describe('event tools surface', () => {
  it('surfaces event, thought, forecast, and outcome artifacts through tool executor', async () => {
    process.env.THUFIR_DB_PATH = createTempDbPath('surface');
    openDatabase();

    const intel = fixtureIntel().filter((item) => item.id === 'intel-3' || item.id === 'intel-4');
    const candidate = extractEventCandidates(intel as any)[0]!;
    const event = upsertEvent({
      title: candidate.canonicalTitle,
      domain: candidate.domain,
      occurredAt: candidate.occurredAt,
      sourceIntelIds: candidate.sourceIntelIds,
      tags: candidate.tags,
    });

    const thought = await generateThoughtForEvent({} as any, {
      event,
      intel: intel as any,
      llm: {
        meta: { provider: 'openai', model: 'test-thought', kind: 'primary' },
        async complete() {
          return {
            model: 'test-thought',
            content: JSON.stringify({
              mechanism: 'Infrastructure damage tightens crude supply.',
              causalChain: ['attack hits infrastructure', 'supply falls', 'oil rises'],
              firstOrderAssets: ['CL'],
              expectedDirectionByAsset: { CL: 'up' },
              disconfirmingConditions: ['facilities restart quickly'],
              confidence: 0.7,
            }),
          };
        },
      } as any,
    });
    createForecastsFromThought(thought!, { horizonHours: [24] });

    const ctx = { config: {}, marketClient: {} } as any;
    const events = await executeToolCall('events_list', { domain: 'energy', limit: 5 }, ctx);
    const latestThought = await executeToolCall('event_latest_thought', { event_id: event.id }, ctx);
    const forecasts = await executeToolCall('event_forecasts', { event_id: event.id }, ctx);
    const cases = await executeToolCall('historical_case_search', { domain: 'energy', tags: ['infrastructure'] }, ctx);

    expect(events.success && (events.data as any).events.length).toBeGreaterThan(0);
    expect(latestThought.success && (latestThought.data as any).thought?.mechanism).toContain('crude supply');
    expect(forecasts.success && (forecasts.data as any).forecasts.length).toBeGreaterThan(0);
    expect(cases.success && (cases.data as any).results.some((entry: any) => entry.case_key === '2019-abqaiq-attack-oil')).toBe(true);
  });
});
