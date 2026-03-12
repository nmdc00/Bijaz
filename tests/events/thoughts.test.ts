import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { extractEventCandidates } from '../../src/events/extract.js';
import { coerceThoughtDraft, assessThoughtMateriality, generateThoughtForEvent } from '../../src/events/thoughts.js';
import type { NormalizedEvent } from '../../src/events/types.js';
import { openDatabase } from '../../src/memory/db.js';
import { getLatestThought, upsertEvent } from '../../src/memory/events.js';
import { storeIntel, type StoredIntel } from '../../src/intel/store.js';

const previousDbPath = process.env.THUFIR_DB_PATH;

function fixtureIntel(): StoredIntel[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(here, 'fixtures/recent-intel-event-clusters.json'), 'utf8')
  ) as StoredIntel[];
}

function createTempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-v195-thoughts-'));
  return join(dir, `${name}.sqlite`);
}

function buildMaterialEvent(): { event: NormalizedEvent; intel: StoredIntel[] } {
  const intel = fixtureIntel().filter((item) => item.id === 'intel-3' || item.id === 'intel-4');
  const candidate = extractEventCandidates(intel)[0]!;
  const event = upsertEvent({
    title: candidate.canonicalTitle,
    domain: candidate.domain,
    occurredAt: candidate.occurredAt,
    sourceIntelIds: candidate.sourceIntelIds,
    tags: candidate.tags,
  });
  return { event, intel };
}

afterEach(() => {
  process.env.THUFIR_DB_PATH = previousDbPath;
});

describe('assessThoughtMateriality', () => {
  it('marks corroborated shock events as material', () => {
    const intel = fixtureIntel().filter((item) => item.id === 'intel-3' || item.id === 'intel-4');
    const candidate = extractEventCandidates(intel)[0]!;
    const assessment = assessThoughtMateriality(
      {
        id: 'evt-1',
        eventKey: candidate.eventKey,
        title: candidate.canonicalTitle,
        domain: candidate.domain,
        occurredAt: candidate.occurredAt,
        sourceIntelIds: candidate.sourceIntelIds,
        tags: candidate.tags,
        status: 'active',
        createdAt: '2026-03-12T00:00:00Z',
        updatedAt: '2026-03-12T00:00:00Z',
      },
      intel
    );

    expect(assessment.material).toBe(true);
    expect(assessment.score).toBeGreaterThanOrEqual(3);
  });
});

describe('coerceThoughtDraft', () => {
  it('clamps confidence and repairs first-order assets into impacted assets', () => {
    const result = coerceThoughtDraft({
      event: {
        id: 'evt-1',
        eventKey: 'event-key',
        title: 'abqaiq attack disrupt saudi oil output',
        domain: 'energy',
        occurredAt: '2026-03-11T05:00:00Z',
        sourceIntelIds: ['intel-3', 'intel-4'],
        tags: ['attack', 'supply_shock'],
        status: 'active',
        createdAt: '2026-03-11T05:00:00Z',
        updatedAt: '2026-03-11T05:00:00Z',
      },
      draft: {
        mechanism: 'Attack disrupts supply and lifts crude pricing.',
        causalChain: ['attack hits infrastructure', 'supply tightens'],
        firstOrderAssets: ['CL', 'BRENTOIL'],
        expectedDirectionByAsset: { CL: 'higher', BRENTOIL: 'up' },
        disconfirmingConditions: ['facilities restart quickly'],
        confidence: 1.4,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.impactedAssets).toEqual([
      { symbol: 'CL', direction: 'up', confidence: 1 },
      { symbol: 'BRENTOIL', direction: 'up', confidence: 1 },
    ]);
  });

  it('rejects drafts missing mechanism or invalidation conditions', () => {
    const result = coerceThoughtDraft({
      event: {
        id: 'evt-1',
        eventKey: 'event-key',
        title: 'fed delays rate cuts',
        domain: 'rates',
        occurredAt: '2026-03-12T13:00:00Z',
        sourceIntelIds: ['intel-5', 'intel-6'],
        tags: ['central_bank', 'inflation'],
        status: 'active',
        createdAt: '2026-03-12T13:00:00Z',
        updatedAt: '2026-03-12T13:00:00Z',
      },
      draft: {
        causalChain: ['rates stay high', 'dollar stays firm'],
        firstOrderAssets: ['DXY'],
        expectedDirectionByAsset: { DXY: 'up' },
        confidence: 0.7,
      },
    });

    expect(result).toBeNull();
  });
});

describe('generateThoughtForEvent', () => {
  it('persists a schema-valid thought for a material event fixture', async () => {
    process.env.THUFIR_DB_PATH = createTempDbPath('persist');
    openDatabase();

    const { event, intel } = buildMaterialEvent();
    for (const item of intel) {
      storeIntel(item);
    }

    const llm = {
      meta: { provider: 'openai' as const, model: 'test-thought-llm', kind: 'primary' as const },
      async complete() {
        return {
          model: 'test-thought-llm',
          content: JSON.stringify({
            mechanism: 'Damage to oil processing infrastructure tightens near-term crude supply.',
            causalChain: [
              'attack damages processing infrastructure',
              'available crude supply falls',
              'benchmark oil prices rise',
            ],
            firstOrderAssets: ['CL', 'BRENTOIL', 'GOLD'],
            expectedDirectionByAsset: {
              CL: 'up',
              BRENTOIL: 'up',
              GOLD: 'up',
            },
            disconfirmingConditions: [
              'facilities restart quickly',
              'strategic reserves offset the outage',
            ],
            confidence: 0.82,
          }),
        };
      },
    };

    const thought = await generateThoughtForEvent({} as any, {
      event,
      intel,
      llm,
    });

    expect(thought).not.toBeNull();
    expect(thought?.mechanism).toContain('crude supply');
    expect(thought?.causalChain.length).toBeGreaterThanOrEqual(2);
    expect(thought?.impactedAssets.map((asset) => asset.symbol)).toEqual(['CL', 'BRENTOIL', 'GOLD']);
    expect(thought?.invalidationConditions).toEqual([
      'facilities restart quickly',
      'strategic reserves offset the outage',
    ]);

    const persisted = getLatestThought(event.id);
    expect(persisted?.mechanism).toBe(thought?.mechanism);
    expect(persisted?.modelVersion).toBe('test-thought-llm');
  });

  it('returns null for non-material events without calling the llm', async () => {
    const llm = {
      async complete() {
        throw new Error('should not be called');
      },
    };

    const thought = await generateThoughtForEvent({} as any, {
      event: {
        id: 'evt-quiet',
        eventKey: 'quiet-key',
        title: 'routine supply commentary',
        domain: 'macro',
        occurredAt: '2026-03-12T00:00:00Z',
        sourceIntelIds: ['intel-quiet'],
        tags: [],
        status: 'active',
        createdAt: '2026-03-12T00:00:00Z',
        updatedAt: '2026-03-12T00:00:00Z',
      },
      intel: [
        {
          id: 'intel-quiet',
          title: 'Routine analyst commentary',
          source: 'Fixture',
          sourceType: 'news',
          timestamp: '2026-03-12T00:00:00Z',
          content: 'Analysts discussed baseline expectations with no major catalyst.',
        },
      ],
      llm: llm as any,
    });

    expect(thought).toBeNull();
  });
});
