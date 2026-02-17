import { describe, expect, it } from 'vitest';
import { AutonomousScanTelemetry } from '../../src/core/performance_metrics.js';

describe('AutonomousScanTelemetry', () => {
  it('summarizes stage timings and execution counts', () => {
    const telemetry = new AutonomousScanTelemetry(1_000);
    telemetry.markDiscoveryDone(1_120);
    telemetry.markFilterDone(1_200);
    telemetry.markFinished(1_380);
    const summary = telemetry.summarize({ expressions: 12, eligible: 4, executed: 1 });

    expect(summary.totalMs).toBe(380);
    expect(summary.discoveryMs).toBe(120);
    expect(summary.filterMs).toBe(80);
    expect(summary.executionMs).toBe(180);
    expect(summary.blockedOrSkipped).toBe(3);
  });
});
