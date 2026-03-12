import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listEvents } from '../../src/memory/events.js';
import { openDatabase } from '../../src/memory/db.js';
import { storeIntel, type StoredIntel } from '../../src/intel/store.js';

const previousDbPath = process.env.THUFIR_DB_PATH;

function loadFixture(): StoredIntel[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(here, 'fixtures/recent-intel-event-clusters.json');
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as StoredIntel[];
}

function createTempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-v195-events-'));
  return join(dir, `${name}.sqlite`);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env.THUFIR_DB_PATH = previousDbPath;
});

describe('extractEventCandidates', () => {
  it('dedupes near-identical intel items into stable event clusters', async () => {
    const { extractEventCandidates } = await import('../../src/events/extract.js');
    const candidates = extractEventCandidates(loadFixture());

    expect(candidates).toHaveLength(3);
    expect(candidates.map((candidate) => candidate.domain)).toEqual(['agri', 'energy', 'rates']);
    expect(candidates[0]?.sourceIntelIds).toEqual(['intel-1', 'intel-2']);
    expect(candidates[1]?.sourceIntelIds).toEqual(['intel-3', 'intel-4']);
    expect(candidates[2]?.sourceIntelIds).toEqual(['intel-5', 'intel-6']);
  });

  it('produces the same event keys regardless of input ordering', async () => {
    const { extractEventCandidates } = await import('../../src/events/extract.js');
    const fixture = loadFixture();

    const forward = extractEventCandidates(fixture).map((candidate) => candidate.eventKey);
    const reversed = extractEventCandidates([...fixture].reverse()).map((candidate) => candidate.eventKey);

    expect(reversed).toEqual(forward);
  });

  it('extracts material tags from merged event text', async () => {
    const { extractEventCandidates } = await import('../../src/events/extract.js');
    const [agri, energy] = extractEventCandidates(loadFixture());

    expect(agri?.tags).toContain('export_ban');
    expect(energy?.tags).toContain('attack');
    expect(energy?.tags).toContain('supply_shock');
  });
});

describe('extractRecentIntelEvents integration', () => {
  it('converts recent intel fixture into the expected persisted event count', async () => {
    process.env.THUFIR_DB_PATH = createTempDbPath('integration');
    openDatabase();

    for (const item of loadFixture()) {
      expect(storeIntel(item)).toBe(true);
    }

    const { extractRecentIntelEvents } = await import('../../src/events/extract.js');
    const events = extractRecentIntelEvents(10);

    expect(events).toHaveLength(3);
    expect(listEvents({ limit: 10 })).toHaveLength(3);
    expect(listEvents({ domain: 'energy', limit: 10 })[0]?.sourceIntelIds).toEqual(['intel-3', 'intel-4']);
  });
});
