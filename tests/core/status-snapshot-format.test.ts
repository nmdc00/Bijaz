import { describe, expect, it } from 'vitest';

import { formatOperatorStatusSnapshot, STATUS_SNAPSHOT_MAX_CHARS } from '../../src/core/status_snapshot.js';

describe('status snapshot formatter', () => {
  it('renders all required fields with fallback-safe values', () => {
    const message = formatOperatorStatusSnapshot({
      asOf: '2026-02-17T10:00:00.000Z',
      equityUsd: null,
      openPositions: [],
      policyState: {
        observationOnly: false,
        reason: null,
        minEdgeOverride: null,
        maxTradesPerScanOverride: null,
        leverageCapOverride: null,
        tradeContractEnforced: false,
        decisionQualityGateEnabled: false,
      },
      lastTrade: null,
      nextScanAt: null,
      uptimeMs: 0,
      runtime: {
        enabled: true,
        fullAuto: false,
        isPaused: false,
        pauseReason: '',
        consecutiveLosses: 0,
        remainingDaily: 100,
      },
      dailyPnl: {
        date: '2026-02-17',
        tradesExecuted: 0,
        wins: 0,
        losses: 0,
        pending: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalPnl: 0,
      },
    });

    expect(message).toContain('Equity:');
    expect(message).toContain('Open positions:');
    expect(message).toContain('Policy state:');
    expect(message).toContain('Last trade outcome:');
    expect(message).toContain('Next scan time:');
    expect(message).toContain('Uptime:');
    expect(message).toContain('Daily P&L:');
    expect(message).toContain('none yet');
    expect(message).toContain('not scheduled');
  });

  it('enforces bounded one-message output length', () => {
    const message = formatOperatorStatusSnapshot({
      asOf: '2026-02-17T10:00:00.000Z',
      equityUsd: null,
      openPositions: Array.from({ length: 20 }).map((_, idx) => ({
        marketId: `MKT_${idx}_${'X'.repeat(30)}`,
        outcome: idx % 2 === 0 ? 'YES' : 'NO',
        exposureUsd: 123.45,
        unrealizedPnlUsd: 5.67,
      })),
      policyState: {
        observationOnly: true,
        reason: 'R'.repeat(500),
        minEdgeOverride: null,
        maxTradesPerScanOverride: null,
        leverageCapOverride: null,
        tradeContractEnforced: true,
        decisionQualityGateEnabled: true,
      },
      lastTrade: {
        marketId: 'BTC',
        outcome: 'win',
        pnlUsd: 1.23,
        timestamp: '2026-02-17T10:00:00.000Z',
      },
      nextScanAt: '2026-02-17T10:15:00.000Z',
      uptimeMs: 30_000_000,
      runtime: {
        enabled: true,
        fullAuto: true,
        isPaused: true,
        pauseReason: 'P'.repeat(200),
        consecutiveLosses: 2,
        remainingDaily: 12.34,
      },
      dailyPnl: {
        date: '2026-02-17',
        tradesExecuted: 9,
        wins: 4,
        losses: 3,
        pending: 2,
        realizedPnl: 1.11,
        unrealizedPnl: 2.22,
        totalPnl: 3.33,
      },
    });

    expect(message.length).toBeLessThanOrEqual(STATUS_SNAPSHOT_MAX_CHARS);
  });
});
