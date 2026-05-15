import { describe, expect, it } from 'vitest';

import { deriveTradePolicyAdjustments } from '../../src/core/trade_policy_adaptation.js';

describe('trade policy adaptation', () => {
  it('derives bounded size, confidence, and cooldown adjustments from weak evidence', () => {
    const rows = deriveTradePolicyAdjustments([
      { win: false, failureMode: 'late_entry', gateHelped: true },
      { win: false, failureMode: 'late_entry', gateHelped: true },
      { win: true, failureMode: 'late_entry', gateHelped: false },
    ]);

    expect(rows.find((row) => row.policyDomain === 'size')).toBeTruthy();
    expect(rows.find((row) => row.policyDomain === 'confidence')).toBeTruthy();
    expect(rows.find((row) => row.policyDomain === 'cooldown')?.policyKey).toContain('late_entry');
  });
});
