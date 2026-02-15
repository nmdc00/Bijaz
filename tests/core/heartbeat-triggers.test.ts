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

describe('heartbeat triggers', () => {
  it('fires liquidation_proximity when liq distance is below threshold', () => {
    const now = Date.now();
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

  it('fires pnl_shift when ROE changes enough', () => {
    const now = Date.now();
    const points: HeartbeatPoint[] = [
      { ts: now - 2000, mid: 100, roePct: 1, liqDistPct: 10 },
      { ts: now - 1000, mid: 100, roePct: 3, liqDistPct: 10 },
    ];
    const fired = evaluateHeartbeatTriggers({
      points,
      cfg: baseCfg,
      nowMs: now,
      lastFiredByTrigger: new Map(),
    });
    expect(fired).toContain('pnl_shift');
  });

  it('fires volatility_spike when move exceeds threshold in window', () => {
    const now = Date.now();
    const points: HeartbeatPoint[] = [
      { ts: now - 3000, mid: 100, roePct: 0, liqDistPct: 10 },
      { ts: now - 2000, mid: 100, roePct: 0, liqDistPct: 10 },
      { ts: now - 1000, mid: 103, roePct: 0, liqDistPct: 10 },
    ];
    const fired = evaluateHeartbeatTriggers({
      points,
      cfg: baseCfg,
      nowMs: now,
      lastFiredByTrigger: new Map(),
    });
    expect(fired).toContain('volatility_spike');
  });

  it('respects cooldown for repeated triggers', () => {
    const now = Date.now();
    const state = new Map<any, any>();
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
