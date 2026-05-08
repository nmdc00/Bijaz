import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const previousDbPath = process.env.THUFIR_DB_PATH;

function createTempDbPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return join(dir, 'thufir.sqlite');
}

describe('position_exit_policy', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.THUFIR_DB_PATH = createTempDbPath('thufir-position-exit-policy-');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    const dbPath = process.env.THUFIR_DB_PATH;
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(dirname(dbPath), { recursive: true, force: true });
    }
    if (previousDbPath === undefined) {
      delete process.env.THUFIR_DB_PATH;
    } else {
      process.env.THUFIR_DB_PATH = previousDbPath;
    }
  });

  it('normalizes symbols on write and read', async () => {
    const { getPositionExitPolicy, upsertPositionExitPolicy } = await import('../../src/memory/position_exit_policy.js');

    upsertPositionExitPolicy(' btc ', 'long', 123, 98.5, 'initial thesis');

    expect(getPositionExitPolicy('BTC')).toEqual({
      symbol: 'BTC',
      side: 'long',
      timeStopAtMs: 123,
      invalidationPrice: 98.5,
      notes: 'initial thesis',
      entryAtMs: expect.any(Number),
      predictionId: null,
    });
  });

  it('preserves entryAtMs across updates to the same symbol', async () => {
    vi.useFakeTimers();
    const { getPositionExitPolicy, upsertPositionExitPolicy } = await import('../../src/memory/position_exit_policy.js');
    const initialTime = new Date('2026-04-24T00:00:00.000Z');

    vi.setSystemTime(initialTime);
    upsertPositionExitPolicy('ETH', 'short', 1_000, 2_500, 'initial');
    const first = getPositionExitPolicy('ETH');

    vi.setSystemTime(new Date('2026-04-24T01:00:00.000Z'));
    upsertPositionExitPolicy('eth', 'short', 2_000, 2_450, 'updated');
    const second = getPositionExitPolicy('ETH');

    expect(first?.entryAtMs).toBe(initialTime.getTime());
    expect(second).toEqual({
      symbol: 'ETH',
      side: 'short',
      timeStopAtMs: 2_000,
      invalidationPrice: 2_450,
      notes: 'updated',
      entryAtMs: first?.entryAtMs ?? null,
      predictionId: null,
    });
  });

  it('clears a saved policy by symbol', async () => {
    const { clearPositionExitPolicy, getPositionExitPolicy, upsertPositionExitPolicy } = await import('../../src/memory/position_exit_policy.js');

    upsertPositionExitPolicy('SOL', 'long', null, null, null);
    expect(getPositionExitPolicy('SOL')).not.toBeNull();

    clearPositionExitPolicy('sol');
    expect(getPositionExitPolicy('SOL')).toBeNull();
  });
});
