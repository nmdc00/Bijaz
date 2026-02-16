/**
 * Hyperliquid Ops Tools
 *
 * These are operational verification tools to help the agent diagnose and
 * close the loop on "missing prerequisite" issues.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { executeToolCall, type ToolExecutorContext } from '../../../core/tool-executor.js';

function toExecutorContext(ctx: ToolContext): ToolExecutorContext {
  return ctx as unknown as ToolExecutorContext;
}

export const hyperliquidVerifyLiveTool: ToolDefinition = {
  name: 'hyperliquid_verify_live',
  description:
    'Run Hyperliquid live verification checks (markets/mids/account/open orders/signer). Read-only.',
  category: 'system',
  schema: z.object({
    symbol: z.string().optional().describe('Perp symbol to check (default: BTC)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('hyperliquid_verify_live', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 10_000,
};

export const hyperliquidOrderRoundtripTool: ToolDefinition = {
  name: 'hyperliquid_order_roundtrip',
  description:
    'Place a tiny far-off limit order and cancel it to verify authenticated trading + cancellation works. Side-effect tool.',
  category: 'trading',
  schema: z.object({
    symbol: z.string().optional().describe('Perp symbol (default: BTC)'),
    side: z.enum(['buy', 'sell']).optional().describe('Side (default: buy)'),
    size: z.number().describe('Order size in base units (e.g., 0.001 BTC). Keep tiny.'),
    price_offset_bps: z
      .number()
      .optional()
      .describe('How far from mid to place the order in bps (default: 5000 = 50%).'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('hyperliquid_order_roundtrip', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: true,
  requiresConfirmation: true,
  cacheTtlMs: 0,
};

export const hyperliquidUsdClassTransferTool: ToolDefinition = {
  name: 'hyperliquid_usd_class_transfer',
  description:
    'Transfer USDC between Hyperliquid Spot and Perp accounts (Spot<->Perp collateral). Side-effect tool.',
  category: 'trading',
  schema: z.object({
    amount_usdc: z.number().describe('USDC amount to transfer (e.g., 10.5).'),
    to: z.enum(['perp', 'spot']).describe('Destination account: perp (spot->perp) or spot (perp->spot).'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall(
      'hyperliquid_usd_class_transfer',
      input as Record<string, unknown>,
      toExecutorContext(ctx)
    );
  },
  sideEffects: true,
  requiresConfirmation: true,
  cacheTtlMs: 0,
};

export const hyperliquidTools: ToolDefinition[] = [
  hyperliquidVerifyLiveTool,
  hyperliquidOrderRoundtripTool,
  hyperliquidUsdClassTransferTool,
];
