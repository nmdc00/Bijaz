import { describe, expect, it } from 'vitest';

import { resolveSessionWeightContext } from '../../src/core/session-weight.js';

describe('resolveSessionWeightContext', () => {
  it.each([
    { at: '2026-02-14T02:00:00Z', expectedSession: 'weekend', expectedWeight: 0.65 },
    { at: '2026-02-16T00:00:00Z', expectedSession: 'asia', expectedWeight: 0.9 },
    { at: '2026-02-16T06:59:59Z', expectedSession: 'asia', expectedWeight: 0.9 },
    { at: '2026-02-16T07:00:00Z', expectedSession: 'europe_open', expectedWeight: 1.0 },
    { at: '2026-02-16T12:59:59Z', expectedSession: 'europe_open', expectedWeight: 1.0 },
    { at: '2026-02-16T13:00:00Z', expectedSession: 'us_open', expectedWeight: 1.15 },
    { at: '2026-02-16T16:59:59Z', expectedSession: 'us_open', expectedWeight: 1.15 },
    { at: '2026-02-16T17:00:00Z', expectedSession: 'us_midday', expectedWeight: 0.95 },
    { at: '2026-02-16T19:59:59Z', expectedSession: 'us_midday', expectedWeight: 0.95 },
    { at: '2026-02-16T20:00:00Z', expectedSession: 'us_close', expectedWeight: 1.05 },
    { at: '2026-02-16T22:59:59Z', expectedSession: 'us_close', expectedWeight: 1.05 },
    { at: '2026-02-16T23:00:00Z', expectedSession: 'asia', expectedWeight: 0.9 },
  ])('maps $at into the expected bucket/weight', ({ at, expectedSession, expectedWeight }) => {
    const context = resolveSessionWeightContext(at);
    expect(context.session).toBe(expectedSession);
    expect(context.sessionWeight).toBeCloseTo(expectedWeight, 6);
  });
});
