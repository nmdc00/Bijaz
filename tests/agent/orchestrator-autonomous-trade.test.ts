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
});
