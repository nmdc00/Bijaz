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

  it('maps market_regime alias to strict enum', () => {
    const normalized = normalizePerpPlaceOrderInput({
      symbol: 'BTC',
      side: 'buy',
      size: 0.1,
      market_regime: 'balanced_up',
    });
    expect(normalized.market_regime).toBe('trending');
  });

  it('maps entry_trigger alias to strict enum', () => {
    const normalized = normalizePerpPlaceOrderInput({
      symbol: 'BTC',
      side: 'buy',
      size: 0.1,
      entry_trigger: 'sustained_buy_imbalance_within_range',
    });
    expect(normalized.entry_trigger).toBe('technical');
  });

  it('drops unknown enum aliases instead of forwarding invalid values', () => {
    const normalized = normalizePerpPlaceOrderInput({
      symbol: 'BTC',
      side: 'buy',
      size: 0.1,
      market_regime: 'mystery_regime',
      entry_trigger: 'new_trigger_family',
    });
    expect(normalized.market_regime).toBeUndefined();
    expect(normalized.entry_trigger).toBeUndefined();
  });

  it('maps close-side aliases to canonical sides for exits', () => {
    const closeLong = normalizePerpPlaceOrderInput({
      symbol: 'BTC',
      side: 'close long',
      size: 0.1,
      reduce_only: true,
    });
    const closeShort = normalizePerpPlaceOrderInput({
      symbol: 'BTC',
      side: 'close short',
      size: 0.1,
      reduce_only: true,
    });
    const slashAlias = normalizePerpPlaceOrderInput({
      symbol: 'BTC',
      side: 'close/short',
      size: 0.1,
      reduce_only: true,
    });
    expect(closeLong.side).toBe('sell');
    expect(closeShort.side).toBe('buy');
    expect(slashAlias.side).toBe('buy');
  });
});
