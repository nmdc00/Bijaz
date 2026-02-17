import { describe, it, expect } from 'vitest';

import {
  evaluateHeartbeatTriggers,
  type HeartbeatPoint,
  type HeartbeatTriggerConfig,
} from '../../src/core/heartbeat_triggers.js';

const baseCfg: HeartbeatTriggerConfig = {
  pnlShiftPct: 1.5,
  liquidationProximityPct: 5,
  volatilitySpikePct: 2,
  volatilitySpikeWindowTicks: 3,
  timeCeilingMinutes: 1,
  triggerCooldownSeconds: 180,
};

const BASE_TS = Date.UTC(2026, 1, 17, 12, 0, 0);

describe('heartbeat triggers', () => {
  it('fires liquidation_proximity when liq distance is below threshold', () => {
    const now = BASE_TS;
    const points: HeartbeatPoint[] = [
      { ts: now - 2000, mid: 100, roePct: 0, liqDistPct: 10 },
      { ts: now - 1000, mid: 100, roePct: 0, liqDistPct: 4.9 },
    ];
    const fired = evaluateHeartbeatTriggers({
      points,
      cfg: baseCfg,
      nowMs: now,
      lastFiredByTrigger: new Map(),
    });
    expect(fired).toContain('liquidation_proximity');
  });

  it('fires pnl_shift when ROE crosses threshold', () => {
    const now = BASE_TS;
    const lastFiredByTrigger = new Map();
    const belowThreshold: HeartbeatPoint[] = [
      { ts: now - 2000, mid: 100, roePct: 1.0, liqDistPct: 10 },
      { ts: now - 1000, mid: 100, roePct: 2.4, liqDistPct: 10 },
    ];
    expect(
      evaluateHeartbeatTriggers({
        points: belowThreshold,
        cfg: baseCfg,
        nowMs: now,
        lastFiredByTrigger,
      })
    ).not.toContain('pnl_shift');

    const points: HeartbeatPoint[] = [
      { ts: now - 2000, mid: 100, roePct: 1, liqDistPct: 10 },
      { ts: now - 1000, mid: 100, roePct: 2.5, liqDistPct: 10 },
    ];
    const fired = evaluateHeartbeatTriggers({
      points,
      cfg: baseCfg,
      nowMs: now,
      lastFiredByTrigger,
    });
    expect(fired).toContain('pnl_shift');
  });

  it('fires volatility_spike when move crosses threshold in window', () => {
    const now = BASE_TS;
    const lastFiredByTrigger = new Map();
    const belowThreshold: HeartbeatPoint[] = [
      { ts: now - 3000, mid: 100, roePct: 0, liqDistPct: 10 },
      { ts: now - 2000, mid: 100, roePct: 0, liqDistPct: 10 },
      { ts: now - 1000, mid: 101.9, roePct: 0, liqDistPct: 10 },
    ];
    expect(
      evaluateHeartbeatTriggers({
        points: belowThreshold,
        cfg: baseCfg,
        nowMs: now,
        lastFiredByTrigger,
      })
    ).not.toContain('volatility_spike');

    const points: HeartbeatPoint[] = [
      { ts: now - 3000, mid: 100, roePct: 0, liqDistPct: 10 },
      { ts: now - 2000, mid: 100, roePct: 0, liqDistPct: 10 },
      { ts: now - 1000, mid: 102, roePct: 0, liqDistPct: 10 },
    ];
    const fired = evaluateHeartbeatTriggers({
      points,
      cfg: baseCfg,
      nowMs: now,
      lastFiredByTrigger,
    });
    expect(fired).toContain('volatility_spike');
  });

  it('fires time_ceiling once elapsed duration reaches configured minutes', () => {
    const now = BASE_TS;
    const points: HeartbeatPoint[] = [
      { ts: now - 59_000, mid: 100, roePct: 0, liqDistPct: 10 },
      { ts: now - 1_000, mid: 100, roePct: 0, liqDistPct: 10 },
    ];
    const state = new Map();
    expect(
      evaluateHeartbeatTriggers({
        points,
        cfg: baseCfg,
        nowMs: now,
        lastFiredByTrigger: state,
      })
    ).not.toContain('time_ceiling');

    const fired = evaluateHeartbeatTriggers({
      points,
      cfg: baseCfg,
      nowMs: now + 1000,
      lastFiredByTrigger: state,
    });
    expect(fired).toContain('time_ceiling');
  });

  it('resets and re-arms each trigger class after safe state and cooldown expiry', () => {
    const now = BASE_TS;
    const cfg: HeartbeatTriggerConfig = { ...baseCfg, triggerCooldownSeconds: 30 };
    const state = new Map();

    const triggerCases: Array<{
      name: 'liquidation_proximity' | 'pnl_shift' | 'volatility_spike' | 'time_ceiling';
      triggerPoints: HeartbeatPoint[];
      safePoints: HeartbeatPoint[];
    }> = [
      {
        name: 'liquidation_proximity',
        triggerPoints: [
          { ts: now - 2000, mid: 100, roePct: 0, liqDistPct: 7 },
          { ts: now - 1000, mid: 100, roePct: 0, liqDistPct: 4.9 },
        ],
        safePoints: [
          { ts: now - 2000, mid: 100, roePct: 0, liqDistPct: 7 },
          { ts: now - 1000, mid: 100, roePct: 0, liqDistPct: 7 },
        ],
      },
      {
        name: 'pnl_shift',
        triggerPoints: [
          { ts: now - 2000, mid: 100, roePct: 1.0, liqDistPct: 10 },
          { ts: now - 1000, mid: 100, roePct: 3.0, liqDistPct: 10 },
        ],
        safePoints: [
          { ts: now - 2000, mid: 100, roePct: 2.0, liqDistPct: 10 },
          { ts: now - 1000, mid: 100, roePct: 2.2, liqDistPct: 10 },
        ],
      },
      {
        name: 'volatility_spike',
        triggerPoints: [
          { ts: now - 3000, mid: 100, roePct: 0, liqDistPct: 10 },
          { ts: now - 2000, mid: 100, roePct: 0, liqDistPct: 10 },
          { ts: now - 1000, mid: 103, roePct: 0, liqDistPct: 10 },
        ],
        safePoints: [
          { ts: now - 3000, mid: 100, roePct: 0, liqDistPct: 10 },
          { ts: now - 2000, mid: 100, roePct: 0, liqDistPct: 10 },
          { ts: now - 1000, mid: 101, roePct: 0, liqDistPct: 10 },
        ],
      },
      {
        name: 'time_ceiling',
        triggerPoints: [
          { ts: now - 61_000, mid: 100, roePct: 0, liqDistPct: 10 },
          { ts: now - 1_000, mid: 100, roePct: 0, liqDistPct: 10 },
        ],
        safePoints: [
          { ts: now - 30_000, mid: 100, roePct: 0, liqDistPct: 10 },
          { ts: now - 1_000, mid: 100, roePct: 0, liqDistPct: 10 },
        ],
      },
    ];

    for (const item of triggerCases) {
      const first = evaluateHeartbeatTriggers({
        points: item.triggerPoints,
        cfg,
        nowMs: now,
        lastFiredByTrigger: state,
      });
      expect(first).toContain(item.name);

      const safe = evaluateHeartbeatTriggers({
        points: item.safePoints,
        cfg,
        nowMs: now + 5_000,
        lastFiredByTrigger: state,
      });
      expect(safe).not.toContain(item.name);

      const second = evaluateHeartbeatTriggers({
        points: item.triggerPoints,
        cfg,
        nowMs: now + 31_000,
        lastFiredByTrigger: state,
      });
      expect(second).toContain(item.name);
    }
  });

  it('respects cooldown for repeated triggers', () => {
    const now = BASE_TS;
    const state = new Map();
    const points: HeartbeatPoint[] = [
      { ts: now - 2000, mid: 100, roePct: 0, liqDistPct: 4.9 },
      { ts: now - 1000, mid: 100, roePct: 0, liqDistPct: 4.9 },
    ];
    const first = evaluateHeartbeatTriggers({
      points,
      cfg: baseCfg,
      nowMs: now,
      lastFiredByTrigger: state,
    });
    expect(first).toContain('liquidation_proximity');

    const second = evaluateHeartbeatTriggers({
      points,
      cfg: baseCfg,
      nowMs: now + 1000,
      lastFiredByTrigger: state,
    });
    expect(second).not.toContain('liquidation_proximity');
  });
});
