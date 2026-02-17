import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-orchestrator-autonomous-'));
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

  it('does not inject terminal trade steps for retrospective trade questions', async () => {
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
                  description: 'Review current portfolio and context',
                  requiresTool: true,
                  toolName: 'get_portfolio',
                  toolInput: {},
                },
              ],
              confidence: 0.8,
              blockers: [],
              reasoning: 'retrospective analysis',
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
          return { content: 'Reviewed previous decisions.' };
        }

        return { content: '{}' };
      },
    };

    const toolRegistry = {
      listNames: () => ['get_portfolio', 'perp_place_order'],
      getLlmSchemas: () => [],
      get: () => undefined,
      execute: async (name: string, input: unknown) => {
        calls.push(name);
        if (name === 'get_portfolio') {
          return mkExecution(name, input as Record<string, unknown>, {
            success: true,
            data: { available_balance: 100 },
          });
        }
        if (name === 'perp_place_order') {
          return mkExecution(name, input as Record<string, unknown>, {
            success: true,
            data: { order_id: 'unexpected' },
          });
        }
        return mkExecution(name, input as Record<string, unknown>, {
          success: false,
          error: `unexpected tool: ${name}`,
        });
      },
    };

    await runOrchestrator(
      'Why did you close the previous BTC long?',
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
      { forceMode: 'trade', skipCritic: true, maxIterations: 6 }
    );

    expect(calls).not.toContain('perp_place_order');
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
    expect(placeOrderInputs[0]?.plan_context).toMatchObject({
      current_step_id: '1',
      plan_goal: 'Buy BTC now',
      mode: 'trade',
    });
  });

  it('normalizes exit_mode aliases and defaults trade_archetype for perp_place_order', async () => {
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
                  toolInput: {
                    symbol: 'BTC',
                    side: 'BUY',
                    size: '0.01',
                    reduce_only: true,
                    exit_mode: 'liquidity_probe',
                  },
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
          return mkExecution(name, payload, { success: true, data: { order_id: 'o-3' } });
        }
        return mkExecution(name, payload, { success: false, error: 'unexpected' });
      },
    };

    await runOrchestrator(
      'Close BTC',
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
    expect(placeOrderInputs[0]?.exit_mode).toBe('risk_reduction');
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

    expect(result.response).toContain('Action: I executed 1 perp order(s).');
  });

  it('enforces agency contract response shape in trade mode', async () => {
    const llm = {
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const system = messages[0]?.content ?? '';

        if (system.includes('You are a planning agent')) {
          return {
            content: JSON.stringify({
              steps: [
                {
                  id: '1',
                  description: 'Fetch portfolio',
                  requiresTool: true,
                  toolName: 'get_portfolio',
                  toolInput: {},
                },
              ],
              confidence: 0.8,
              blockers: [],
              reasoning: 'check state',
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
            content: "You're all-in right now. If you want, we can reduce.",
          };
        }

        return { content: '{}' };
      },
    };

    const toolRegistry = {
      listNames: () => ['get_portfolio'],
      getLlmSchemas: () => [],
      get: () => undefined,
      execute: async (name: string, input: unknown) =>
        mkExecution(name, input as Record<string, unknown>, {
          success: true,
          data: { available_balance: 12.6 },
        }),
    };

    const result = await runOrchestrator(
      'Buy BTC perp now',
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

    expect(result.response).toContain('Action:');
    expect(result.response).toContain('Book State:');
    expect(result.response).toContain('Risk:');
    expect(result.response).toContain('Next Action:');
    expect(result.response).not.toContain('If you want');
  });

  it('prefetches trade_review and journal tools for retrospective/loss trade diagnostics', async () => {
    const calls: string[] = [];
    const llm = {
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const system = messages[0]?.content ?? '';
        if (system.includes('You are synthesizing a response')) {
          return { content: 'I reviewed the loss context.' };
        }
        return { content: '{}' };
      },
    };

    const toolRegistry = {
      listNames: () => ['trade_review', 'perp_trade_journal_list'],
      getLlmSchemas: () => [],
      get: () => undefined,
      execute: async (name: string, input: unknown) => {
        calls.push(name);
        return mkExecution(name, input as Record<string, unknown>, {
          success: true,
          data: { ok: true },
        });
      },
    };

    await runOrchestrator(
      "You're losing money now dude",
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
      { forceMode: 'trade', skipPlanning: true, skipCritic: true, maxIterations: 2 }
    );

    expect(calls).toContain('trade_review');
    expect(calls).toContain('perp_trade_journal_list');
  });

  it('overrides claimed Action line with deterministic failure summary when trade fails', async () => {
    const llm = {
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const system = messages[0]?.content ?? '';

        if (system.includes('You are a planning agent')) {
          return {
            content: JSON.stringify({
              steps: [
                {
                  id: '1',
                  description: 'Place trade',
                  requiresTool: true,
                  toolName: 'perp_place_order',
                  toolInput: { symbol: 'BTC', side: 'buy', size: 0.01 },
                },
              ],
              confidence: 0.7,
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
          return {
            content: [
              'Action: I executed 2 perp order(s).',
              'Book State: I am managing the book from the latest portfolio snapshot.',
              'Risk: Execution risk is currently controlled.',
              'Next Action: Continue.',
            ].join('\n'),
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
          success: false,
          error: 'Hyperliquid trade failed: Order could not immediately match against any resting orders.',
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
      { forceMode: 'trade', skipCritic: true, maxIterations: 4 }
    );

    expect(result.response).toContain('Action: I did not execute a new perp order.');
    expect(result.response).toContain('Book State:');
    expect(result.response).toContain('Risk:');
    expect(result.response).toContain('Next Action:');
    expect(result.response).not.toContain('Action: I executed 2 perp order(s).');
  });

  it('skips redundant tools.list steps and continues with subsequent plan steps', async () => {
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
                  description: 'List tools',
                  requiresTool: true,
                  toolName: 'tools.list',
                  toolInput: {},
                },
                {
                  id: '2',
                  description: 'Fetch portfolio',
                  requiresTool: true,
                  toolName: 'get_portfolio',
                  toolInput: {},
                },
              ],
              confidence: 0.8,
              blockers: [],
              reasoning: 'introspect then fetch',
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
            content: 'Action: done\nBook State: from portfolio\nRisk: low\nNext Action: continue',
          };
        }

        return { content: '{}' };
      },
    };

    const toolRegistry = {
      listNames: () => ['tools.list', 'get_portfolio'],
      getLlmSchemas: () => [],
      get: () => undefined,
      execute: async (name: string, input: unknown) => {
        calls.push(name);
        if (name === 'get_portfolio') {
          return mkExecution(name, input as Record<string, unknown>, {
            success: true,
            data: { available_balance: 100 },
          });
        }
        if (name === 'tools.list') {
          return mkExecution(name, input as Record<string, unknown>, {
            success: true,
            data: { count: 2, tools: ['tools.list', 'get_portfolio'] },
          });
        }
        return mkExecution(name, input as Record<string, unknown>, {
          success: false,
          error: `unexpected tool: ${name}`,
        });
      },
    };

    const result = await runOrchestrator(
      'Review portfolio health',
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

    expect(calls.includes('tools.list')).toBe(false);
    expect(calls.filter((name) => name === 'get_portfolio').length).toBeGreaterThan(0);
    const toolNames = result.state.toolExecutions.map((execution) => execution.toolName);
    expect(toolNames).toContain('tools.list');
    expect(toolNames).toContain('get_portfolio');
    const toolsListExecution = result.state.toolExecutions.find(
      (execution) => execution.toolName === 'tools.list'
    );
    expect(toolsListExecution?.cached).toBe(true);
    expect((toolsListExecution?.result as { success: true; data: { skipped?: boolean } }).data.skipped).toBe(
      true
    );
  });

  it('runs independent read-only tool steps concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const llm = {
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const system = messages[0]?.content ?? '';
        if (system.includes('You are a planning agent')) {
          return {
            content: JSON.stringify({
              steps: [
                {
                  id: '1',
                  description: 'Fetch portfolio',
                  requiresTool: true,
                  toolName: 'get_portfolio',
                  toolInput: {},
                },
                {
                  id: '2',
                  description: 'Fetch open orders',
                  requiresTool: true,
                  toolName: 'get_open_orders',
                  toolInput: {},
                },
              ],
              confidence: 0.8,
              blockers: [],
              reasoning: 'parallel reads',
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
            content: 'Action: done\nBook State: ok\nRisk: low\nNext Action: continue',
          };
        }
        return { content: '{}' };
      },
    };

    const toolRegistry = {
      listNames: () => ['get_portfolio', 'get_open_orders'],
      getLlmSchemas: () => [],
      get: (name: string) => ({ sideEffects: false, requiresConfirmation: false, name } as any),
      execute: async (name: string, input: unknown) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlight -= 1;
        return mkExecution(name, input as Record<string, unknown>, { success: true, data: { ok: true } });
      },
    };

    await runOrchestrator(
      'Review my account',
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

    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('skips mutating trade tools for analysis-style requests without explicit execution intent', async () => {
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
                  description: 'Cancel order',
                  requiresTool: true,
                  toolName: 'perp_cancel_order',
                  toolInput: { order_id: '123' },
                },
              ],
              confidence: 0.8,
              blockers: [],
              reasoning: 'attempt cancel',
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
            content:
              'Action: I cancelled an order.\nBook State: updated.\nRisk: low.\nNext Action: monitor.',
          };
        }
        return { content: '{}' };
      },
    };

    const toolRegistry = {
      listNames: () => ['perp_cancel_order'],
      getLlmSchemas: () => [],
      get: (_name: string) => ({ sideEffects: true, requiresConfirmation: true } as any),
      execute: async (name: string, input: unknown) => {
        calls.push(name);
        return mkExecution(name, input as Record<string, unknown>, { success: true, data: { cancelled: true } });
      },
    };

    const result = await runOrchestrator(
      'Thoughts on this trade and what should I do next?',
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

    expect(calls).toEqual([]);
    const cancelExec = result.state.toolExecutions.find((execution) => execution.toolName === 'perp_cancel_order');
    expect(cancelExec).toBeDefined();
    expect((cancelExec?.result as { success: true; data: { skipped?: boolean } }).data.skipped).toBe(true);
    expect(result.response).toContain('Action: I did not place a new perp order in this cycle.');
  });
});
