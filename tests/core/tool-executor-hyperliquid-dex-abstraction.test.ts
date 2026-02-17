import { describe, it, expect, vi } from 'vitest';

const mockState = vi.hoisted(() => {
  return {
    dexAbstraction: true as boolean | null,
    spotState: {
      balances: [{ coin: 'USDC', total: '16.86', hold: '0', token: '0', entryNtl: '0' }],
      evmEscrows: [],
    },
    perpState: {
      assetPositions: [],
      marginSummary: { accountValue: '0', totalNtlPos: '0', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalMarginUsed: '0' },
      withdrawable: '0',
      crossMaintenanceMarginUsed: '0',
    },
  };
});

vi.mock('../../src/memory/portfolio.js', () => {
  return { getCashBalance: () => 999 };
});

vi.mock('../../src/execution/hyperliquid/client.js', () => {
  class HyperliquidClient {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(_config: any) {}

    getAccountAddress() {
      return '0x0000000000000000000000000000000000000000';
    }

    async getUserDexAbstraction() {
      return mockState.dexAbstraction;
    }

    async getClearinghouseState() {
      return mockState.perpState;
    }

    async getSpotClearinghouseState() {
      return mockState.spotState as any;
    }

    async getUserFees() {
      return {} as any;
    }

    async getPortfolioMetrics() {
      return [] as any;
    }
  }
  return { HyperliquidClient };
});

describe('get_portfolio dex abstraction semantics', () => {
  it('when dex abstraction is enabled, available_balance reflects spot USDC free (unified collateral)', async () => {
    const { executeToolCall } = await import('../../src/core/tool-executor.js');
    const res = await executeToolCall(
      'get_portfolio',
      {},
      { config: { execution: { mode: 'paper' }, hyperliquid: { enabled: true } } as any } as any
    );
    expect(res.success).toBe(true);
    const data = (res as any).data;
    expect(data.summary.hyperliquid_dex_abstraction).toBe(true);
    expect(data.summary.hyperliquid_spot_usdc_free).toBeCloseTo(16.86, 6);
    expect(data.summary.hyperliquid_perp_withdrawable_usdc).toBeCloseTo(0, 6);
    expect(data.summary.available_balance).toBeCloseTo(16.86, 6);
  });
});

