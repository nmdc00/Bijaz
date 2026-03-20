import { describe, expect, it } from 'vitest';

import {
  buildLegacyExitContract,
  evaluateExitContract,
  parseExitContract,
  serializeExitContract,
  summarizeExitContract,
} from '../../src/core/exit_contract.js';

describe('exit_contract', () => {
  it('round-trips valid contracts', () => {
    const contract = {
      thesis: 'Hold while BTC trend structure remains intact',
      hardRules: [
        { metric: 'mark_price', op: '<=', value: 84000, action: 'close', reason: 'structure lost' },
      ],
      reviewGuidance: ['If breakout stalls, reduce risk.'],
    } as const;

    const parsed = parseExitContract(serializeExitContract(contract));
    expect(parsed).toEqual(contract);
  });

  it('evaluates deterministic hard rules against heartbeat state', () => {
    const contract = parseExitContract({
      thesis: 'Manage BTC trend',
      hardRules: [
        { metric: 'liq_dist_pct', op: '<', value: 3, action: 'reduce', reason: 'risk too tight', reduceToFraction: 0.4 },
      ],
      reviewGuidance: [],
    });
    const decision = evaluateExitContract(contract, { markPrice: 90000, roePct: 4, liqDistPct: 2.5 });
    expect(decision).toEqual(
      expect.objectContaining({
        action: 'reduce',
        reason: 'risk too tight',
        reduceToFraction: 0.4,
      })
    );
  });

  it('builds a sane legacy contract from invalidation metadata', () => {
    const contract = buildLegacyExitContract({
      thesis: 'ETH breakout continuation',
      invalidationPrice: 2950,
      side: 'long',
    });

    expect(contract.hardRules).toEqual([
      expect.objectContaining({
        metric: 'mark_price',
        op: '<=',
        value: 2950,
        action: 'close',
      }),
    ]);
    expect(summarizeExitContract(contract)).toContain('ETH breakout continuation');
  });

  it('returns null for malformed contracts instead of throwing', () => {
    expect(parseExitContract('{not json')).toBeNull();
    expect(parseExitContract({ thesis: '', hardRules: [] })).toBeNull();
  });

  it('skips rules whose metric is unavailable and evaluates later rules', () => {
    const contract = parseExitContract({
      thesis: 'Manage BTC trend',
      hardRules: [
        { metric: 'liq_dist_pct', op: '<', value: 2, action: 'close', reason: 'too close to liq' },
        { metric: 'roe_pct', op: '>=', value: 8, action: 'close', reason: 'take the win' },
      ],
      reviewGuidance: [],
    });
    const decision = evaluateExitContract(contract, { markPrice: 92000, roePct: 8.2, liqDistPct: null });
    expect(decision).toEqual(
      expect.objectContaining({
        action: 'close',
        reason: 'take the win',
      })
    );
  });
});
