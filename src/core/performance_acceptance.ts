export interface PerformanceWindowMetrics {
  scanP50Ms: number;
  scanP95Ms: number;
  apiCallsPerCycle: number;
  executionErrorRatePct: number;
  invalidOrderRatePct: number;
}

export interface PerformanceAcceptanceBudgets {
  maxRegressionPct: number;
  absoluteMaxScanP95Ms?: number;
  absoluteMaxExecutionErrorRatePct?: number;
  absoluteMaxInvalidOrderRatePct?: number;
}

export interface PerformanceAcceptanceCheck {
  name: string;
  passed: boolean;
  baseline: number | null;
  candidate: number;
  threshold: number;
}

export interface PerformanceAcceptanceResult {
  passed: boolean;
  checks: PerformanceAcceptanceCheck[];
}

function allowedRegression(value: number, maxRegressionPct: number): number {
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return value * (1 + maxRegressionPct / 100);
}

export function evaluatePerformanceAcceptance(params: {
  baseline: PerformanceWindowMetrics;
  candidate: PerformanceWindowMetrics;
  budgets?: Partial<PerformanceAcceptanceBudgets>;
}): PerformanceAcceptanceResult {
  const maxRegressionPct = Number(params.budgets?.maxRegressionPct ?? 10);
  const budgets: PerformanceAcceptanceBudgets = {
    maxRegressionPct: Number.isFinite(maxRegressionPct) ? Math.max(0, maxRegressionPct) : 10,
    absoluteMaxScanP95Ms: params.budgets?.absoluteMaxScanP95Ms,
    absoluteMaxExecutionErrorRatePct: params.budgets?.absoluteMaxExecutionErrorRatePct,
    absoluteMaxInvalidOrderRatePct: params.budgets?.absoluteMaxInvalidOrderRatePct,
  };
  const checks: PerformanceAcceptanceCheck[] = [];
  const addCheck = (name: string, baseline: number | null, candidate: number, threshold: number) => {
    checks.push({ name, passed: candidate <= threshold, baseline, candidate, threshold });
  };

  addCheck(
    'scan_p50_regression',
    params.baseline.scanP50Ms,
    params.candidate.scanP50Ms,
    allowedRegression(params.baseline.scanP50Ms, budgets.maxRegressionPct)
  );
  addCheck(
    'scan_p95_regression',
    params.baseline.scanP95Ms,
    params.candidate.scanP95Ms,
    allowedRegression(params.baseline.scanP95Ms, budgets.maxRegressionPct)
  );
  addCheck(
    'api_calls_per_cycle_regression',
    params.baseline.apiCallsPerCycle,
    params.candidate.apiCallsPerCycle,
    allowedRegression(params.baseline.apiCallsPerCycle, budgets.maxRegressionPct)
  );
  addCheck(
    'execution_error_rate_regression',
    params.baseline.executionErrorRatePct,
    params.candidate.executionErrorRatePct,
    allowedRegression(params.baseline.executionErrorRatePct, budgets.maxRegressionPct)
  );
  addCheck(
    'invalid_order_rate_regression',
    params.baseline.invalidOrderRatePct,
    params.candidate.invalidOrderRatePct,
    allowedRegression(params.baseline.invalidOrderRatePct, budgets.maxRegressionPct)
  );

  if (budgets.absoluteMaxScanP95Ms != null) {
    addCheck('scan_p95_absolute', null, params.candidate.scanP95Ms, budgets.absoluteMaxScanP95Ms);
  }
  if (budgets.absoluteMaxExecutionErrorRatePct != null) {
    addCheck(
      'execution_error_rate_absolute',
      null,
      params.candidate.executionErrorRatePct,
      budgets.absoluteMaxExecutionErrorRatePct
    );
  }
  if (budgets.absoluteMaxInvalidOrderRatePct != null) {
    addCheck(
      'invalid_order_rate_absolute',
      null,
      params.candidate.invalidOrderRatePct,
      budgets.absoluteMaxInvalidOrderRatePct
    );
  }

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}
