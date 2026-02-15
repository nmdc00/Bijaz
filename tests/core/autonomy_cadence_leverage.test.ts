import { describe, expect, test } from 'vitest';

import { AutonomousManager } from '../../src/core/autonomous.js';

// We only test pure decision logic. No network / DB assumptions.

describe('AutonomousManager leverage + cadence heuristics', () => {
  test('decideLeverage defaults to 1 for low edge/confidence', () => {
    const mgr: any = {
      thufirConfig: { wallet: { perps: { maxLeverage: 5 } } },
      decideLeverage: (AutonomousManager as any).prototype.decideLeverage,
    };
    const lev = mgr.decideLeverage({
      expectedEdge: 0.05,
      confidence: 0.6,
      volatilityPulsePct: 0.2,
      fundingRate: 0,
      side: 'buy',
      marketMaxLeverage: 50,
    });
    expect(lev).toBe(1);
  });

  test('decideLeverage increases with edge/confidence, caps at wallet/market max', () => {
    const mgr: any = {
      thufirConfig: { wallet: { perps: { maxLeverage: 2 } } },
      decideLeverage: (AutonomousManager as any).prototype.decideLeverage,
    };
    const lev = mgr.decideLeverage({
      expectedEdge: 0.1,
      confidence: 0.8,
      volatilityPulsePct: 0.2,
      fundingRate: 0,
      side: 'buy',
      marketMaxLeverage: 5,
    });
    expect(lev).toBe(2);
  });

  test('decideLeverage penalizes high volatility pulse', () => {
    const mgr: any = {
      thufirConfig: { wallet: { perps: { maxLeverage: 5 } } },
      decideLeverage: (AutonomousManager as any).prototype.decideLeverage,
    };
    const lev = mgr.decideLeverage({
      expectedEdge: 0.1,
      confidence: 0.8,
      volatilityPulsePct: 1.5,
      fundingRate: 0,
      side: 'buy',
      marketMaxLeverage: 5,
    });
    expect(lev).toBe(2);
  });

  test('decideLeverage penalizes funding against position', () => {
    const mgr: any = {
      thufirConfig: { wallet: { perps: { maxLeverage: 5 } } },
      decideLeverage: (AutonomousManager as any).prototype.decideLeverage,
    };
    const lev = mgr.decideLeverage({
      expectedEdge: 0.1,
      confidence: 0.8,
      volatilityPulsePct: 0.1,
      fundingRate: 0.001, // against longs in this model
      side: 'buy',
      marketMaxLeverage: 5,
    });
    expect(lev).toBe(2);
  });

  test('decideMaxTradesThisScan reduces to 1 in high volatility', () => {
    const mgr: any = {
      config: { maxTradesPerScan: 3 },
      lastGlobalPulsePct: 1.2,
      decideMaxTradesThisScan: (AutonomousManager as any).prototype.decideMaxTradesThisScan,
    };
    expect(mgr.decideMaxTradesThisScan()).toBe(1);
  });
});

