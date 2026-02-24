import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('get_portfolio paper mode semantics', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-hl-dex-abstraction-'));
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

  it('in paper mode, available_balance reflects paper bankroll regardless of dex abstraction', async () => {
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
    expect(data.summary.perp_enabled).toBe(true);
    expect(data.summary.paper_perp_enabled).toBe(true);
    expect(data.summary.live_perp_enabled).toBe(false);
    expect(data.hyperliquid_balances).toBeNull();
  });
});
