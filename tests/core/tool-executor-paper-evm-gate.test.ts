import { describe, expect, it } from 'vitest';

import { executeToolCall } from '../../src/core/tool-executor.js';

describe('tool-executor paper mode EVM gates', () => {
  const ctx = {
    config: {
      execution: { mode: 'paper', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
    } as any,
  } as any;

  it('blocks evm_erc20_balance in paper mode', async () => {
    const res = await executeToolCall(
      'evm_erc20_balance',
      {
        chain: 'arbitrum',
        token_address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        address: '0x0000000000000000000000000000000000000000',
      },
      ctx
    );
    expect(res.success).toBe(false);
    expect(String((res as any).error ?? '')).toContain('paper mode');
  });

  it('blocks evm_usdc_balances in paper mode', async () => {
    const res = await executeToolCall(
      'evm_usdc_balances',
      { address: '0x0000000000000000000000000000000000000000' },
      ctx
    );
    expect(res.success).toBe(false);
    expect(String((res as any).error ?? '')).toContain('paper mode');
  });

  it('blocks cctp_bridge_usdc in paper mode', async () => {
    const res = await executeToolCall(
      'cctp_bridge_usdc',
      { from_chain: 'polygon', to_chain: 'arbitrum', amount_usdc: 1 },
      ctx
    );
    expect(res.success).toBe(false);
    expect(String((res as any).error ?? '')).toContain('paper mode');
  });
});
