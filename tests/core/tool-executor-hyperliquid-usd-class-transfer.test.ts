import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-hl-usd-class-transfer-'));
    process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');
  });

  afterEach(() => {
    if (process.env.THUFIR_DB_PATH) {
      rmSync(process.env.THUFIR_DB_PATH, { force: true });
      rmSync(dirname(process.env.THUFIR_DB_PATH), { recursive: true, force: true });
    }
    if (originalDbPath === undefined) {
      delete process.env.THUFIR_DB_PATH;
    } else {
      process.env.THUFIR_DB_PATH = originalDbPath;
    }
  });

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

  it('get_portfolio in paper mode reports paper bankroll without live Hyperliquid collateral blending', async () => {
    const { executeToolCall } = await import('../../src/core/tool-executor.js');
    const res = await executeToolCall(
      'get_portfolio',
      {},
      { config: { execution: { mode: 'paper' }, hyperliquid: { enabled: true } } as any } as any
    );
    expect(res.success).toBe(true);
    const data = (res as any).data;
    expect(data.balances.usdc).toBe(200);
    expect(data.summary.onchain_usdc).toBe(200);
    expect(data.summary.execution_mode).toBe('paper');
    expect(data.summary.available_balance).toBe(200);
    expect(data.hyperliquid_balances).toBeNull();
    expect(data.perp_positions).toEqual([]);
  });

  it('get_portfolio in paper mode ignores live spot/perp balances even when live balances exist', async () => {
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
    expect(data.summary.execution_mode).toBe('paper');
    expect(data.summary.onchain_usdc).toBe(200);
    expect(data.summary.available_balance).toBe(200);
    expect(data.summary.perp_enabled).toBe(false);
    expect(data.hyperliquid_balances).toBeNull();
  });
});
