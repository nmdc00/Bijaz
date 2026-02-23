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

describe('orchestrator routing guards', () => {
  it('does not invoke registry.execute for unavailable planner tools', async () => {
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
                  description: 'resolve symbol',
                  requiresTool: true,
                  toolName: 'symbol_resolve',
                  toolInput: { query: 'BTC' },
                },
                {
                  id: '2',
                  description: 'check portfolio',
                  requiresTool: true,
                  toolName: 'get_portfolio',
                  toolInput: {},
                },
              ],
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
      listNames: () => ['get_portfolio'],
      getLlmSchemas: () => [],
      get: () => undefined,
      execute: async (name: string, input: unknown) => {
        calls.push(name);
        return mkExecution(name, input as Record<string, unknown>, { success: true, data: {} });
      },
    };

    const result = await runOrchestrator(
      'Check fake capital routing',
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

    expect(calls).toEqual(['get_portfolio']);
    expect(
      result.state.toolExecutions.some(
        (e) => e.toolName === 'symbol_resolve' && e.result.success === false
      )
    ).toBe(false);
  });

  it('normalizes placeholder symbols to concrete defaults before perp tool execution', async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const llm = {
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const system = messages[0]?.content ?? '';
        if (system.includes('You are a planning agent')) {
          return {
            content: JSON.stringify({
              steps: [
                {
                  id: '1',
                  description: 'analyze selected symbol',
                  requiresTool: true,
                  toolName: 'perp_analyze',
                  toolInput: { symbol: '__SELECTED_FROM_STEP_7__', horizon: '5m' },
                },
              ],
            }),
          };
        }
        if (system.includes('You resolve tool call parameters')) {
          return { content: JSON.stringify({ symbol: '__SELECTED_FROM_STEP_7__', horizon: '5m' }) };
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
      listNames: () => ['perp_analyze'],
      getLlmSchemas: () => [],
      get: () => undefined,
      execute: async (name: string, input: unknown) => {
        const typed = input as Record<string, unknown>;
        inputs.push(typed);
        return mkExecution(name, typed, { success: true, data: { ok: true } });
      },
    };

    await runOrchestrator(
      'Analyze placeholder symbol',
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
      { forceMode: 'trade', skipCritic: true, maxIterations: 5 }
    );

    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[0]?.symbol).toBe('BTC');
  });

  it('blocks autonomous system_exec before executor invocation', async () => {
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
                  description: 'inspect workspace',
                  requiresTool: true,
                  toolName: 'system_exec',
                  toolInput: { command: 'ls' },
                },
              ],
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
      listNames: () => ['system_exec'],
      getLlmSchemas: () => [],
      get: () => undefined,
      execute: async (name: string, input: unknown) => {
        calls.push(name);
        return mkExecution(name, input as Record<string, unknown>, { success: true, data: { ok: true } });
      },
    };

    const result = await runOrchestrator(
      'Heartbeat check',
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
      { forceMode: 'trade', skipCritic: true, maxIterations: 4, executionOrigin: 'autonomous' }
    );

    expect(calls).toEqual([]);
    expect(result.state.toolExecutions.some((e) => e.toolName === 'system_exec')).toBe(false);
  });
});
