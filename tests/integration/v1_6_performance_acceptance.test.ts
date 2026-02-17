import { describe, expect, it } from 'vitest';
import { evaluatePerformanceAcceptance } from '../../src/core/performance_acceptance.js';

describe('v1.6 performance acceptance', () => {
  it('passes when candidate stays within regression budget', () => {
    const baseline = {
      scanP50Ms: 1500,
      scanP95Ms: 4000,
      apiCallsPerCycle: 12,
      executionErrorRatePct: 4,
      invalidOrderRatePct: 2,
    };
    const candidate = {
      scanP50Ms: 1450,
      scanP95Ms: 4100, // +2.5%
      apiCallsPerCycle: 11,
      executionErrorRatePct: 4.2, // +5%
      invalidOrderRatePct: 2.1, // +5%
    };

    const result = evaluatePerformanceAcceptance({
      baseline,
      candidate,
      budgets: { maxRegressionPct: 10, absoluteMaxScanP95Ms: 5000 },
    });

    expect(result.passed).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('fails when candidate regresses beyond budget', () => {
    const baseline = {
      scanP50Ms: 1500,
      scanP95Ms: 4000,
      apiCallsPerCycle: 12,
      executionErrorRatePct: 4,
      invalidOrderRatePct: 2,
    };
    const candidate = {
      scanP50Ms: 2000,
      scanP95Ms: 5500,
      apiCallsPerCycle: 18,
      executionErrorRatePct: 8,
      invalidOrderRatePct: 4.5,
    };

    const result = evaluatePerformanceAcceptance({
      baseline,
      candidate,
      budgets: {
        maxRegressionPct: 10,
        absoluteMaxScanP95Ms: 5000,
        absoluteMaxExecutionErrorRatePct: 6,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => !c.passed)).toBe(true);
  });
});
