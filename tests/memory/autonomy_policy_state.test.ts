import { beforeEach, describe, expect, it, vi } from 'vitest';

let row: { payload?: string; updated_at?: string } | undefined;

const fakeDb = {
  exec: vi.fn(),
  prepare: (sql: string) => {
    if (sql.includes('SELECT payload')) {
      return { get: () => row };
    }
    if (sql.includes('INSERT INTO autonomy_policy_state')) {
      return {
        run: (params: Record<string, unknown>) => {
          row = {
            payload: String(params.payload ?? '{}'),
            updated_at: '2026-02-16 00:00:00',
          };
        },
      };
    }
    return { get: () => undefined, run: () => ({}) };
  },
};

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => fakeDb,
}));

import {
  clearExpiredObservationMode,
  getAutonomyPolicyState,
  upsertAutonomyPolicyState,
} from '../../src/memory/autonomy_policy_state.js';

beforeEach(() => {
  row = undefined;
});

describe('autonomy_policy_state', () => {
  it('upserts and reads adaptive state payload', () => {
    const next = upsertAutonomyPolicyState({
      minEdgeOverride: 0.08,
      maxTradesPerScanOverride: 2,
      reason: 'test',
    });

    expect(next.minEdgeOverride).toBe(0.08);
    const loaded = getAutonomyPolicyState();
    expect(loaded.maxTradesPerScanOverride).toBe(2);
    expect(loaded.reason).toBe('test');
  });

  it('clears expired observation mode windows', () => {
    upsertAutonomyPolicyState({
      observationOnlyUntilMs: Date.now() - 1,
      reason: 'expired',
    });

    const cleared = clearExpiredObservationMode(Date.now());
    expect(cleared.observationOnlyUntilMs).toBeNull();
    expect(cleared.reason).toBeNull();
  });
});
