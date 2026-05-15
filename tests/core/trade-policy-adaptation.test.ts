import { describe, expect, it } from 'vitest';

import {
  deriveTradePolicyAdjustments,
  selectRuntimeTradePolicyAdjustments,
} from '../../src/core/trade_policy_adaptation.js';

describe('trade policy adaptation', () => {
  it('derives bounded size/confidence adjustments but withholds cooldown rejects on weak evidence', () => {
    const rows = deriveTradePolicyAdjustments([
      { win: false, failureMode: 'late_entry', gateHelped: true },
      { win: false, failureMode: 'late_entry', gateHelped: true },
      { win: true, failureMode: 'late_entry', gateHelped: false },
    ]);

    expect(rows.find((row) => row.policyDomain === 'size')).toBeTruthy();
    expect(rows.find((row) => row.policyDomain === 'confidence')).toBeTruthy();
    expect(rows.find((row) => row.policyDomain === 'cooldown')).toBeUndefined();
  });

  it('selects only scope-matching, actionable persisted runtime adjustments', () => {
    const rows = selectRuntimeTradePolicyAdjustments(
      [
        {
          id: 'adj-size-1',
          policyDomain: 'size',
          policyKey: 'setup_family_max_size',
          scope: { signalClass: 'momentum_breakout', symbolClass: 'crypto' },
          adjustmentType: 'scale',
          oldValue: 1,
          newValue: 0.7,
          delta: -0.3,
          evidenceCount: 4,
          evidenceWindowStart: null,
          evidenceWindowEnd: null,
          reasonSummary: 'Cut size for this segment.',
          confidence: 0.7,
          active: true,
          createdAt: '2026-05-15T00:00:00.000Z',
          expiresAt: null,
        },
        {
          id: 'adj-cooldown-weak',
          policyDomain: 'cooldown',
          policyKey: 'failure_mode:late_entry',
          scope: { signalClass: 'momentum_breakout', symbolClass: 'crypto' },
          adjustmentType: 'flag',
          oldValue: false,
          newValue: true,
          delta: null,
          evidenceCount: 3,
          evidenceWindowStart: null,
          evidenceWindowEnd: null,
          reasonSummary: 'Too weak to hard reject.',
          confidence: 0.38,
          active: true,
          createdAt: '2026-05-15T00:00:00.000Z',
          expiresAt: null,
        },
        {
          id: 'adj-other-signal',
          policyDomain: 'size',
          policyKey: 'setup_family_max_size',
          scope: { signalClass: 'mean_reversion', symbolClass: 'crypto' },
          adjustmentType: 'scale',
          oldValue: 1,
          newValue: 0.6,
          delta: -0.4,
          evidenceCount: 6,
          evidenceWindowStart: null,
          evidenceWindowEnd: null,
          reasonSummary: 'Wrong segment.',
          confidence: 0.8,
          active: true,
          createdAt: '2026-05-15T00:00:00.000Z',
          expiresAt: null,
        },
      ],
      {
        signalClass: 'momentum_breakout',
        symbolClass: 'crypto',
        strategySource: 'autonomous_quant',
      }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: 'adj-size-1',
        policyDomain: 'size',
      })
    );
  });
});
