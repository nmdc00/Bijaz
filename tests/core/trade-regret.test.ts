import { describe, expect, it } from 'vitest';

import { buildTradeCounterfactuals } from '../../src/core/trade_counterfactuals.js';
import { buildTradeRegretSummary } from '../../src/core/trade_regret.js';

describe('trade regret synthesis', () => {
  it('marks resize regret when full-size counterfactual would have outperformed', () => {
    const counterfactuals = buildTradeCounterfactuals({
      requestedSize: 10,
      approvedSize: 5,
      netRealizedPnlUsd: 4,
      capturedR: 1,
      gateVerdict: 'resize',
    });

    const regret = buildTradeRegretSummary({
      review: {
        thesisVerdict: 'correct',
        entryQuality: 'adequate',
        sizingQuality: 'weak',
        leverageQuality: 'adequate',
        exitQuality: 'adequate',
        gateInterventionQuality: 'weak',
        contextFit: 'adequate',
        reviewConfidence: 0.8,
        counterfactualNeeded: true,
        mainSuccessDriver: null,
        mainFailureMode: null,
        lessons: [],
        repeatTags: [],
        avoidTags: [],
      },
      counterfactuals,
      executed: true,
      gateVerdict: 'resize',
      realizedPnlUsd: 4,
    });

    expect(regret.resizeHurtFlag).toBe(true);
    expect(regret.summary).toContain('resize_hurt');
  });
});
