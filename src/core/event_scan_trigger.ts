export interface EventScanTriggerInput {
  eventKey: string;
  itemCount: number;
  minItems: number;
  nowMs?: number;
}

export interface EventScanTriggerDecision {
  allowed: boolean;
  reason: 'disabled' | 'below_min_items' | 'cooldown' | 'allowed';
  waitMs?: number;
}

export class EventScanTriggerCoordinator {
  private readonly enabled: boolean;
  private readonly cooldownMs: number;
  private lastTriggeredByKey = new Map<string, number>();

  constructor(options?: { enabled?: boolean; cooldownMs?: number }) {
    this.enabled = options?.enabled ?? false;
    this.cooldownMs = Math.max(0, Number(options?.cooldownMs ?? 120_000));
  }

  evaluate(input: EventScanTriggerInput): EventScanTriggerDecision {
    if (!this.enabled) {
      return { allowed: false, reason: 'disabled' };
    }
    if (input.itemCount < input.minItems) {
      return { allowed: false, reason: 'below_min_items' };
    }

    const nowMs = input.nowMs ?? Date.now();
    const last = this.lastTriggeredByKey.get(input.eventKey);
    if (last != null) {
      const elapsed = nowMs - last;
      if (elapsed < this.cooldownMs) {
        return { allowed: false, reason: 'cooldown', waitMs: this.cooldownMs - elapsed };
      }
    }

    return { allowed: true, reason: 'allowed' };
  }

  markTriggered(eventKey: string, nowMs?: number): void {
    this.lastTriggeredByKey.set(eventKey, nowMs ?? Date.now());
  }

  tryAcquire(input: EventScanTriggerInput): EventScanTriggerDecision {
    const decision = this.evaluate(input);
    if (decision.allowed) {
      this.markTriggered(input.eventKey, input.nowMs);
    }
    return decision;
  }
}
