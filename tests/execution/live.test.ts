import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('ethers', () => {
  const mockWallet = {
    address: '0x1234567890abcdef1234567890abcdef12345678',
  };

  const makeBn = () => ({
    mul: () => makeBn(),
    div: () => makeBn(),
    lt: () => false,
    toString: () => '1',
  });

  return {
    ethers: {
      Wallet: class {
        address = mockWallet.address;
      },
      utils: {
        parseUnits: vi.fn(() => makeBn()),
      },
    },
  };
});

vi.mock('../../src/execution/wallet/manager.js', () => ({
  loadWallet: vi.fn(() => ({
    address: '0x1234567890abcdef1234567890abcdef12345678',
  })),
}));

const mockApprove = vi.fn();
const mockBuy = vi.fn().mockResolvedValue({ hash: '0xhash' });
const mockAllowance = vi.fn().mockResolvedValue({ lt: () => false });
vi.mock('../../src/execution/augur/amm.js', () => ({
  AugurAMMTrader: class {
    approveUsdc = mockApprove;
    buy = mockBuy;
    allowance = mockAllowance;
  },
}));

vi.mock('../../src/execution/wallet/limits.js', () => ({
  SpendingLimitEnforcer: class {
    checkAndReserve = vi.fn().mockResolvedValue({ allowed: true });
  },
}));

vi.mock('../../src/memory/predictions.js', () => ({
  createPrediction: vi.fn(() => 'pred-123'),
  recordExecution: vi.fn(),
}));

vi.mock('../../src/memory/trades.js', () => ({
  recordTrade: vi.fn(),
}));

vi.mock('../../src/memory/audit.js', () => ({
  logWalletOperation: vi.fn(),
}));

import { AugurLiveExecutor } from '../../src/execution/modes/augur-live.js';
import type { Market } from '../../src/execution/markets.js';

describe('AugurLiveExecutor', () => {
  const mockConfig = {
    augur: { slippageTolerance: 0.02 },
    wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
  };

  const mockMarket: Market = {
    id: 'market-123',
    question: 'Will X happen?',
    outcomes: ['Yes', 'No'],
    prices: { YES: 0.6, NO: 0.4 },
    platform: 'augur',
    augur: { marketFactory: '0xFactory', marketIndex: 1, type: 'crypto', shareTokens: [] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns hold message for hold decisions', async () => {
    const executor = new AugurLiveExecutor({ config: mockConfig as any, password: 'test' });
    const result = await executor.execute(mockMarket, { action: 'hold' });
    expect(result.executed).toBe(false);
    expect(result.message).toContain('Hold');
  });

  it('rejects invalid decisions without amount or outcome', async () => {
    const executor = new AugurLiveExecutor({ config: mockConfig as any, password: 'test' });
    const result = await executor.execute(mockMarket, { action: 'buy' });
    expect(result.executed).toBe(false);
    expect(result.message).toContain('Invalid decision');
  });

  it('executes buy orders', async () => {
    const executor = new AugurLiveExecutor({ config: mockConfig as any, password: 'test' });
    const result = await executor.execute(mockMarket, {
      action: 'buy',
      outcome: 'YES',
      amount: 10,
      confidence: 'medium',
    });
    expect(result.executed).toBe(true);
    expect(mockBuy).toHaveBeenCalled();
  });
});
