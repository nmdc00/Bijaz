import { describe, expect, it } from 'vitest';
import { classifyToolFailure } from '../../src/agent/orchestrator/retry_classifier.js';

describe('classifyToolFailure', () => {
  it('marks contract/input failures as terminal', () => {
    const r1 = classifyToolFailure('perp_place_order', 'Missing/invalid trade_archetype (scalp|intraday|swing)');
    const r2 = classifyToolFailure('perp_place_order', 'thesis_invalidation_hit=true conflicts with non-invalidation exit_mode');
    const r3 = classifyToolFailure('perp_place_order', 'Invalid input: invalid enum value');
    expect(r1.classification).toBe('terminal');
    expect(r2.classification).toBe('terminal');
    expect(r3.classification).toBe('terminal');
  });

  it('marks transient capacity/network failures as retryable', () => {
    const r1 = classifyToolFailure('perp_place_order', 'Telegram onMessage timed out after 60000ms');
    const r2 = classifyToolFailure('perp_place_order', 'LLM rate limit 429');
    const r3 = classifyToolFailure('perp_place_order', 'network EAI_AGAIN');
    expect(r1.classification).toBe('retryable');
    expect(r2.classification).toBe('retryable');
    expect(r3.classification).toBe('retryable');
  });
});
