import { describe, expect, it } from 'vitest';

import { normalizePerpPlaceOrderInput } from '../../src/agent/orchestrator/orchestrator.js';

describe('normalizePerpPlaceOrderInput', () => {
  it('maps liquidity_probe exit mode to risk_reduction', () => {
    const normalized = normalizePerpPlaceOrderInput({
      symbol: 'BTC',
      side: 'sell',
      size: 0.1,
      reduce_only: true,
      exit_mode: 'liquidity_probe',
    });
    expect(normalized.exit_mode).toBe('risk_reduction');
  });

  it('maps emergency_override exit mode to risk_reduction', () => {
    const normalized = normalizePerpPlaceOrderInput({
      symbol: 'BTC',
      side: 'sell',
      size: 0.1,
      reduce_only: true,
      exit_mode: 'emergency_override',
    });
    expect(normalized.exit_mode).toBe('risk_reduction');
  });

  it('maps thesis-like aliases to thesis_invalidation and aligns invalidation flag', () => {
    const normalized = normalizePerpPlaceOrderInput({
      symbol: 'BTC',
      side: 'sell',
      size: 0.1,
      reduce_only: true,
      exit_mode: 'stop_loss',
      thesis_invalidation_hit: 'false',
    });
    expect(normalized.exit_mode).toBe('thesis_invalidation');
    expect(normalized.thesis_invalidation_hit).toBe(true);
  });
});
