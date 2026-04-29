/**
 * v195_pipeline_wiring.test.ts
 *
 * Verifies that the v1.95 event pipeline modules are callable end-to-end:
 *  1. extractRecentIntelEvents — reads recent intel from DB and normalises to events
 *  2. resolveExpiredForecasts  — checks expired open forecasts and records outcomes
 *
 * Both functions operate on the SQLite DB via better-sqlite3. In the test
 * environment the DB is empty, so we assert shape/behaviour rather than counts.
 */
import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal DB mock — better-sqlite3 is a native addon not available in vitest.
// We stub it at module level so the memory/events and intel/store modules
// that both pipeline functions depend on initialise cleanly.
// ---------------------------------------------------------------------------

const stmtMock = {
  run: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
  get: vi.fn(() => undefined),
  all: vi.fn(() => []),
};

const dbMock = {
  prepare: vi.fn(() => stmtMock),
  exec: vi.fn(),
  pragma: vi.fn(),
  transaction: vi.fn((fn: (...args: unknown[]) => unknown) => fn),
};

vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => dbMock),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v1.95 pipeline wiring', () => {
  it('extractRecentIntelEvents returns an array without throwing', async () => {
    const { extractRecentIntelEvents } = await import('../../src/events/extract.js');
    const result = extractRecentIntelEvents(5);
    expect(Array.isArray(result)).toBe(true);
  });

  it('resolveExpiredForecasts returns checked >= 0 and resolved === 0 on empty DB', async () => {
    const { resolveExpiredForecasts } = await import('../../src/events/outcomes.js');
    const batch = await resolveExpiredForecasts({
      resolveMove: async () => null,
    });
    expect(batch.checked).toBeGreaterThanOrEqual(0);
    expect(batch.resolved).toBe(0);
    expect(Array.isArray(batch.outcomes)).toBe(true);
  });
});
