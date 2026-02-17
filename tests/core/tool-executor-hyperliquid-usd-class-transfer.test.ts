import { describe, it, expect, vi } from 'vitest';

// Hoisted mocks must run before importing tool-executor.
const mockState = vi.hoisted(() => {
  return {
    usdClassTransferCalls: [] as Array<{ amount: string; toPerp: boolean }>,
    clearinghouseState: {
      assetPositions: [],
      marginSummary: { accountValue: '10', totalNtlPos: '0', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: '10', totalNtlPos: '0', totalMarginUsed: '0' },
      withdrawable: '5',
      crossMaintenanceMarginUsed: '0',
    },
    spotState: {
      balances: [{ coin: 'USDC', total: '16.86', hold: '0', token: '0', entryNtl: '0' }],
      evmEscrows: [],
    },
  };
});

vi.mock('../../src/memory/portfolio.js', () => {
  return { getCashBalance: () => 123 };
});

vi.mock('../../src/execution/hyperliquid/client.js', () => {
  class HyperliquidClient {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(_config: any) {}

    getAccountAddress() {
      return '0x0000000000000000000000000000000000000000';
    }

    getExchangeClient() {
      return {
        usdClassTransfer: async ({ amount, toPerp }: { amount: string; toPerp: boolean }) => {
          mockState.usdClassTransferCalls.push({ amount, toPerp });
          return { ok: true };
        },
      };
    }

    async getUserDexAbstraction() {
      return false;
    }

    async getClearinghouseState() {
      return mockState.clearinghouseState;
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

describe('tool-executor hyperliquid_usd_class_transfer + portfolio semantics', () => {
  it('hyperliquid_usd_class_transfer calls ExchangeClient.usdClassTransfer with amount string and toPerp=true', async () => {
    const { executeToolCall } = await import('../../src/core/tool-executor.js');
    const res = await executeToolCall(
      'hyperliquid_usd_class_transfer',
      { amount_usdc: 1.23, to: 'perp' },
      { config: { execution: { mode: 'paper' }, hyperliquid: { enabled: true } } as any } as any
    );
    expect(res.success).toBe(true);
    expect(mockState.usdClassTransferCalls.length).toBe(1);
    expect(mockState.usdClassTransferCalls[0]).toEqual({ amount: '1.23', toPerp: true });
  });

  it('hyperliquid_usd_class_transfer supports to=spot (toPerp=false)', async () => {
    mockState.usdClassTransferCalls = [];
    const { executeToolCall } = await import('../../src/core/tool-executor.js');
    const res = await executeToolCall(
      'hyperliquid_usd_class_transfer',
      { amount_usdc: 2, to: 'spot' },
      { config: { execution: { mode: 'paper' }, hyperliquid: { enabled: true } } as any } as any
    );
    expect(res.success).toBe(true);
    expect(mockState.usdClassTransferCalls[0]).toEqual({ amount: '2', toPerp: false });
  });

  it('get_portfolio prefers Hyperliquid perp withdrawable as available_balance when perp has funds', async () => {
    const { executeToolCall } = await import('../../src/core/tool-executor.js');
    const res = await executeToolCall(
      'get_portfolio',
      {},
      { config: { execution: { mode: 'paper' }, hyperliquid: { enabled: true } } as any } as any
    );
    expect(res.success).toBe(true);
    const data = (res as any).data;
    expect(data.balances.usdc).toBe(123); // on-chain/memory cash
    expect(data.summary.onchain_usdc).toBe(123);
    expect(data.summary.hyperliquid_dex_abstraction).toBe(false);
    expect(data.summary.hyperliquid_spot_usdc_free).toBeCloseTo(16.86, 6);
    expect(data.summary.hyperliquid_perp_withdrawable_usdc).toBeCloseTo(5, 6);
    expect(data.summary.available_balance).toBeCloseTo(5, 6); // prefer perp withdrawable when it has funds
  });

  it('get_portfolio falls back to spot USDC free when dexAbstraction is false and perp withdrawable is 0', async () => {
    // Simulate unified account where API reports dexAbstraction=false but funds are only in spot
    mockState.clearinghouseState = {
      assetPositions: [],
      marginSummary: { accountValue: '0', totalNtlPos: '0', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalMarginUsed: '0' },
      withdrawable: '0',
      crossMaintenanceMarginUsed: '0',
    };
    const { executeToolCall } = await import('../../src/core/tool-executor.js');
    const res = await executeToolCall(
      'get_portfolio',
      {},
      { config: { execution: { mode: 'paper' }, hyperliquid: { enabled: true } } as any } as any
    );
    expect(res.success).toBe(true);
    const data = (res as any).data;
    expect(data.summary.hyperliquid_dex_abstraction).toBe(false);
    expect(data.summary.hyperliquid_perp_withdrawable_usdc).toBeCloseTo(0, 6);
    expect(data.summary.hyperliquid_spot_usdc_free).toBeCloseTo(16.86, 6);
    // Should fall back to spot USDC free instead of reporting 0
    expect(data.summary.available_balance).toBeCloseTo(16.86, 6);
  });
});
