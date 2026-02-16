import { describe, expect, it } from 'vitest';

import { runOrchestrator } from '../../src/agent/orchestrator/orchestrator.js';
import type { ToolExecution } from '../../src/agent/tools/types.js';

function mkExecution(
  toolName: string,
  input: Record<string, unknown>,
  result: ToolExecution['result']
): ToolExecution {
  return {
    toolName,
    input,
    result,
    timestamp: new Date().toISOString(),
    durationMs: 1,
    cached: false,
  };
}

describe('runOrchestrator autonomous trade contract', () => {
  it('injects and executes a terminal trade tool when planner omits it', async () => {
    const calls: string[] = [];

    const llm = {
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const system = messages[0]?.content ?? '';

        if (system.includes('You are a planning agent')) {
          return {
            content: JSON.stringify({
              steps: [
                {
                  id: '1',
                  description: 'Check portfolio',
                  requiresTool: true,
                  toolName: 'get_portfolio',
                  toolInput: {},
                },
                {
                  id: '2',
                  description: 'Check open orders',
                  requiresTool: true,
                  toolName: 'get_open_orders',
                  toolInput: {},
                },
              ],
              confidence: 0.8,
              blockers: [],
              reasoning: 'pre-trade checks',
              warnings: [],
            }),
          };
        }

        if (system.includes('You are a reflection agent')) {
          return {
            content: JSON.stringify({
              hypothesisUpdates: [],
              assumptionUpdates: [],
              confidenceChange: 0,
              newInformation: [],
              nextStep: 'continue',
              suggestRevision: false,
              revisionReason: null,
            }),
          };
        }

        if (system.includes('You resolve tool call parameters')) {
          return {
            content: JSON.stringify({
              symbol: 'BTC',
              side: 'buy',
              size: 0.01,
              order_type: 'market',
            }),
          };
        }

        if (system.includes('You are synthesizing a response')) {
          return {
            content: 'Executed autonomous trade flow.',
          };
        }

        return { content: '{}' };
      },
    };

    const toolRegistry = {
      listNames: () => ['get_portfolio', 'get_open_orders', 'perp_place_order'],
      getLlmSchemas: () => [
        {
          name: 'perp_place_order',
          description: 'Place order',
          input_schema: {
            type: 'object',
            properties: {
              symbol: { type: 'string' },
              side: { type: 'string' },
              size: { type: 'number' },
              order_type: { type: 'string' },
            },
          },
        },
      ],
      get: () => undefined,
      execute: async (name: string, input: unknown) => {
        calls.push(name);
        const payload = input as Record<string, unknown>;
        if (name === 'get_portfolio') {
          return mkExecution(name, payload, {
            success: true,
            data: { available_balance: 100 },
          });
        }
        if (name === 'get_open_orders') {
          return mkExecution(name, payload, {
            success: true,
            data: { orders: [] },
          });
        }
        if (name === 'perp_place_order') {
          return mkExecution(name, payload, {
            success: true,
            data: { order_id: 'o-1' },
          });
        }
        return mkExecution(name, payload, {
          success: false,
          error: `unexpected tool: ${name}`,
        });
      },
    };

    const result = await runOrchestrator(
      'Buy BTC perp autonomously',
      {
        llm: llm as any,
        toolRegistry: toolRegistry as any,
        identity: {
          name: 'Thufir',
          role: 'Trader',
          traits: ['tool-first'],
          marker: 'THUFIR_HAWAT',
          rawContent: {},
          missingFiles: [],
        } as any,
        toolContext: {} as any,
      },
      { forceMode: 'trade', skipCritic: true, maxIterations: 8 }
    );

    expect(result.state.mode).toBe('trade');
    expect(calls).toContain('perp_place_order');
    expect(
      result.state.toolExecutions.some((execution) => execution.toolName === 'perp_place_order')
    ).toBe(true);
  });

  it('normalizes invalid perp_place_order size before tool execution', async () => {
    const placeOrderInputs: Array<Record<string, unknown>> = [];

    const llm = {
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const system = messages[0]?.content ?? '';

        if (system.includes('You are a planning agent')) {
          return {
            content: JSON.stringify({
              steps: [
                {
                  id: '1',
                  description: 'Place trade directly',
                  requiresTool: true,
                  toolName: 'perp_place_order',
                  toolInput: { symbol: 'BTC', side: 'BUY', size: '0', order_type: 'MARKET' },
                },
              ],
              confidence: 0.8,
              blockers: [],
              reasoning: 'execute',
              warnings: [],
            }),
          };
        }

        if (system.includes('You are a reflection agent')) {
          return {
            content: JSON.stringify({
              hypothesisUpdates: [],
              assumptionUpdates: [],
              confidenceChange: 0,
              newInformation: [],
              nextStep: 'continue',
              suggestRevision: false,
              revisionReason: null,
            }),
          };
        }

        if (system.includes('You are synthesizing a response')) {
          return { content: 'done' };
        }

        return { content: '{}' };
      },
    };

    const toolRegistry = {
      listNames: () => ['perp_place_order'],
      getLlmSchemas: () => [],
      get: () => undefined,
      execute: async (name: string, input: unknown) => {
        const payload = input as Record<string, unknown>;
        if (name === 'perp_place_order') {
          placeOrderInputs.push(payload);
          return mkExecution(name, payload, { success: true, data: { order_id: 'o-2' } });
        }
        return mkExecution(name, payload, { success: false, error: 'unexpected' });
      },
    };

    await runOrchestrator(
      'Buy BTC now',
      {
        llm: llm as any,
        toolRegistry: toolRegistry as any,
        identity: {
          name: 'Thufir',
          role: 'Trader',
          traits: ['tool-first'],
          marker: 'THUFIR_HAWAT',
          rawContent: {},
          missingFiles: [],
        } as any,
        toolContext: {} as any,
      },
      { forceMode: 'trade', skipCritic: true, maxIterations: 4 }
    );

    expect(placeOrderInputs.length).toBe(1);
    expect(placeOrderInputs[0]?.side).toBe('buy');
    expect(placeOrderInputs[0]?.order_type).toBe('market');
    expect(typeof placeOrderInputs[0]?.size).toBe('number');
    expect((placeOrderInputs[0]?.size as number) > 0).toBe(true);
  });

  it('falls back to deterministic execution summary when critic disapproves without revision', async () => {
    const llm = {
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const system = messages[0]?.content ?? '';

        if (system.includes('You are a planning agent')) {
          return {
            content: JSON.stringify({
              steps: [
                {
                  id: '1',
                  description: 'Try placing order',
                  requiresTool: true,
                  toolName: 'perp_place_order',
                  toolInput: { symbol: 'BTC', side: 'buy', size: 0.01 },
                },
              ],
              confidence: 0.7,
              blockers: [],
              reasoning: 'trade',
              warnings: [],
            }),
          };
        }

        if (system.includes('You are a reflection agent')) {
          return {
            content: JSON.stringify({
              hypothesisUpdates: [],
              assumptionUpdates: [],
              confidenceChange: 0,
              newInformation: [],
              nextStep: 'continue',
              suggestRevision: false,
              revisionReason: null,
            }),
          };
        }

        if (system.includes('You are synthesizing a response')) {
          return {
            content: 'Filled immediately at best price.',
          };
        }

        if (system.includes('You are a critical reviewer')) {
          return {
            content: JSON.stringify({
              approved: false,
              issues: [
                {
                  type: 'unsupported_claim',
                  severity: 'critical',
                  description: 'Claimed fill despite failure',
                },
              ],
            }),
          };
        }

        return { content: '{}' };
      },
    };

    const toolRegistry = {
      listNames: () => ['perp_place_order'],
      getLlmSchemas: () => [],
      get: () => undefined,
      execute: async (name: string, input: unknown) =>
        mkExecution(name, input as Record<string, unknown>, {
          success: true,
          data: { order_id: 'ok-1' },
        }),
    };

    const result = await runOrchestrator(
      'Buy BTC now',
      {
        llm: llm as any,
        toolRegistry: toolRegistry as any,
        identity: {
          name: 'Thufir',
          role: 'Trader',
          traits: ['tool-first'],
          marker: 'THUFIR_HAWAT',
          rawContent: {},
          missingFiles: [],
        } as any,
        toolContext: {} as any,
      },
      { forceMode: 'trade', maxIterations: 4 }
    );

    expect(result.response).toContain('Action: Executed 1 perp order(s).');
  });
});
