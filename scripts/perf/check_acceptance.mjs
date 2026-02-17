#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluatePerformanceAcceptance } from '../../src/core/performance_acceptance.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part?.startsWith('--')) continue;
    const key = part.slice(2);
    const value = argv[i + 1];
    out[key] = value;
    i += 1;
  }
  return out;
}

async function readJson(path) {
  const text = await readFile(resolve(process.cwd(), path), 'utf-8');
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselinePath = args.baseline;
  const candidatePath = args.candidate;
  if (!baselinePath || !candidatePath) {
    console.error('Usage: node scripts/perf/check_acceptance.mjs --baseline <file> --candidate <file> [--max-regression-pct 10]');
    process.exit(2);
  }

  const baseline = await readJson(baselinePath);
  const candidate = await readJson(candidatePath);
  const budgets = {
    maxRegressionPct: Number(args['max-regression-pct'] ?? 10),
    absoluteMaxScanP95Ms: args['max-scan-p95-ms'] != null ? Number(args['max-scan-p95-ms']) : undefined,
    absoluteMaxExecutionErrorRatePct:
      args['max-exec-error-pct'] != null ? Number(args['max-exec-error-pct']) : undefined,
    absoluteMaxInvalidOrderRatePct:
      args['max-invalid-order-pct'] != null ? Number(args['max-invalid-order-pct']) : undefined,
  };

  const result = evaluatePerformanceAcceptance({ baseline, candidate, budgets });
  for (const check of result.checks) {
    console.log(
      `${check.passed ? 'PASS' : 'FAIL'} ${check.name} baseline=${check.baseline ?? 'n/a'} candidate=${check.candidate} threshold=${check.threshold}`
    );
  }
  if (!result.passed) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
