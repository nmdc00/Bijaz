import { describe, expect, it } from 'vitest';

import { buildTradeCounterfactuals } from '../../src/core/trade_counterfactuals.js';

describe('trade counterfactuals', () => {
  it('builds bounded v2.2 counterfactual records from intervention evidence', () => {
    const rows = buildTradeCounterfactuals({
      requestedSize: 10,
      approvedSize: 5,
      requestedLeverage: 4,
      approvedLeverage: 2,
      netRealizedPnlUsd: -6,
      capturedR: -0.5,
      gateVerdict: 'resize',
    });

    expect(rows.map((row) => row.counterfactualType)).toEqual(
      expect.arrayContaining(['no_trade', 'full_size', 'approved_size', 'delay_entry', 'ttl_exit', 'leverage_cap'])
    );
    expect(rows.find((row) => row.counterfactualType === 'full_size')?.estimatedNetPnlUsd).toBe(-12);
    expect(rows.find((row) => row.counterfactualType === 'no_trade')?.estimatedNetPnlUsd).toBe(0);
  });
});
