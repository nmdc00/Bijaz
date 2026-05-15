import { describe, expect, it } from 'vitest';

import { applyAdaptiveDecisionEnforcement } from '../../src/core/adaptive_decision_enforcer.js';

describe('adaptive decision enforcer', () => {
  it('deterministically downsizes or rejects based on retrieval and active policy adjustments', () => {
    const result = applyAdaptiveDecisionEnforcement({
      requestedNotionalUsd: 100,
      requestedLeverage: 4,
      retrieval: {
        recommendation: 'size_reduction',
        retrievalSupportScore: 0.32,
        retrievalConfidence: 0.3,
        retrievalRiskFlags: ['sparse_precedent', 'late_entry_cluster'],
      },
      policyAdjustments: [
        {
          id: 'adj-size-1',
          policyDomain: 'size',
          policyKey: 'setup_family_max_size',
          adjustmentType: 'scale',
          oldValue: 1,
          newValue: 0.7,
          delta: -0.3,
          evidenceCount: 4,
          confidence: 0.7,
          reasonSummary: 'Cut size.',
        },
        {
          id: 'adj-cooldown-1',
          policyDomain: 'cooldown',
          policyKey: 'failure_mode:late_entry',
          adjustmentType: 'flag',
          oldValue: false,
          newValue: true,
          delta: null,
          evidenceCount: 6,
          confidence: 0.72,
          reasonSummary: 'Cooldown.',
        },
      ],
    });

    expect(result.verdict).toBe('reject');
    expect(result.approvedNotionalUsd).toBeLessThan(100);
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['sparse_precedent', 'late_entry_cluster']));
    expect(result.policyTrace.triggeredCooldowns).toContain('failure_mode:late_entry');
    expect(result.policyTrace.activeAdjustmentIds).toEqual(
      expect.arrayContaining(['adj-size-1', 'adj-cooldown-1'])
    );
  });

  it('ignores weak cooldown rows so sparse evidence cannot hard reject a live candidate', () => {
    const result = applyAdaptiveDecisionEnforcement({
      requestedNotionalUsd: 100,
      requestedLeverage: 4,
      retrieval: {
        recommendation: 'approval',
        retrievalSupportScore: 0.62,
        retrievalConfidence: 0.71,
        retrievalRiskFlags: [],
      },
      policyAdjustments: [
        {
          id: 'adj-cooldown-weak',
          policyDomain: 'cooldown',
          policyKey: 'failure_mode:late_entry',
          adjustmentType: 'flag',
          oldValue: false,
          newValue: true,
          delta: null,
          evidenceCount: 3,
          confidence: 0.38,
          reasonSummary: 'Too weak for a hard reject.',
        },
      ],
    });

    expect(result.verdict).toBe('approve');
    expect(result.policyTrace.triggeredCooldowns).toEqual([]);
    expect(result.policyTrace.activeAdjustmentIds).toEqual([]);
  });
});
