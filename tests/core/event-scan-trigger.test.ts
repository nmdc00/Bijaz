import { describe, expect, it } from 'vitest';
import { EventScanTriggerCoordinator } from '../../src/core/event_scan_trigger.js';

describe('EventScanTriggerCoordinator', () => {
  it('blocks when disabled', () => {
    const coordinator = new EventScanTriggerCoordinator({ enabled: false, cooldownMs: 10_000 });
    const decision = coordinator.tryAcquire({
      eventKey: 'intel',
      itemCount: 5,
      minItems: 1,
      nowMs: 1_000,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('disabled');
  });

  it('blocks below threshold and allows above threshold', () => {
    const coordinator = new EventScanTriggerCoordinator({ enabled: true, cooldownMs: 10_000 });
    const blocked = coordinator.tryAcquire({
      eventKey: 'intel',
      itemCount: 0,
      minItems: 1,
      nowMs: 1_000,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('below_min_items');

    const allowed = coordinator.tryAcquire({
      eventKey: 'intel',
      itemCount: 2,
      minItems: 1,
      nowMs: 2_000,
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toBe('allowed');
  });

  it('enforces cooldown per event key', () => {
    const coordinator = new EventScanTriggerCoordinator({ enabled: true, cooldownMs: 5_000 });
    const first = coordinator.tryAcquire({
      eventKey: 'intel',
      itemCount: 2,
      minItems: 1,
      nowMs: 1_000,
    });
    const second = coordinator.tryAcquire({
      eventKey: 'intel',
      itemCount: 2,
      minItems: 1,
      nowMs: 2_000,
    });
    const third = coordinator.tryAcquire({
      eventKey: 'intel',
      itemCount: 2,
      minItems: 1,
      nowMs: 7_000,
    });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('cooldown');
    expect(third.allowed).toBe(true);
  });

  it('tracks cooldown independently by event key', () => {
    const coordinator = new EventScanTriggerCoordinator({ enabled: true, cooldownMs: 5_000 });
    const intel = coordinator.tryAcquire({
      eventKey: 'intel',
      itemCount: 2,
      minItems: 1,
      nowMs: 1_000,
    });
    const market = coordinator.tryAcquire({
      eventKey: 'market_anomaly',
      itemCount: 2,
      minItems: 1,
      nowMs: 2_000,
    });
    expect(intel.allowed).toBe(true);
    expect(market.allowed).toBe(true);
  });
});
