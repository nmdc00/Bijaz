import { describe, expect, it } from 'vitest';

import { revisePlan } from '../../src/agent/planning/planner.js';
import type { AgentPlan } from '../../src/agent/planning/types.js';

describe('planner revisePlan', () => {
  it('preserves completed step status and result when revision omits statuses', async () => {
    const llm = {
      complete: async () => ({
        content: JSON.stringify({
          steps: [
            {
              id: '1',
              description: 'Keep prior completed portfolio check',
              requiresTool: true,
              toolName: 'get_portfolio',
              toolInput: {},
            },
            {
              id: '2',
              description: 'Proceed to place order',
              requiresTool: true,
              toolName: 'perp_place_order',
              toolInput: { symbol: 'BTC', side: 'buy', size: 0.01 },
            },
          ],
          confidence: 0.75,
          changes: ['Adjusted terminal step'],
        }),
      }),
    };

    const plan: AgentPlan = {
      id: 'p1',
      goal: 'trade BTC',
      steps: [
        {
          id: '1',
          description: 'Check portfolio',
          requiresTool: true,
          toolName: 'get_portfolio',
          toolInput: {},
          status: 'complete',
          result: { success: true, data: { available_balance: 100 } },
        },
        {
          id: '2',
          description: 'Place order',
          requiresTool: true,
          toolName: 'perp_place_order',
          toolInput: { symbol: 'BTC', side: 'buy', size: 0.01 },
          status: 'pending',
        },
      ],
      complete: false,
      blockers: [],
      confidence: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revisionCount: 0,
    };

    const revised = await revisePlan(llm as any, {
      plan,
      reason: 'tool_result_unexpected',
      context: 'refresh',
    });

    const step1 = revised.plan.steps.find((s) => s.id === '1');
    expect(step1?.status).toBe('complete');
    expect(step1?.result).toEqual({ success: true, data: { available_balance: 100 } });
  });

  it('enforces runtime-available tools during revision and adapts playbook input', async () => {
    const llm = {
      complete: async () => ({
        content: JSON.stringify({
          steps: [
            {
              id: '1',
              description: 'Use unsupported batch helper',
              requiresTool: true,
              toolName: 'perp_action_batch_or_equivalent',
              toolInput: {},
            },
            {
              id: '2',
              description: 'Fallback to search playbook',
              requiresTool: true,
              toolName: 'playbook_get',
              toolInput: { key: 'HEARTBEAT.md' },
            },
          ],
          confidence: 0.7,
          changes: ['rewrite plan'],
        }),
      }),
    };

    const plan: AgentPlan = {
      id: 'p2',
      goal: 'fix runtime',
      steps: [
        {
          id: '1',
          description: 'initial step',
          requiresTool: true,
          toolName: 'get_portfolio',
          toolInput: {},
          status: 'pending',
        },
      ],
      complete: false,
      blockers: [],
      confidence: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revisionCount: 0,
    };

    const revised = await revisePlan(llm as any, {
      plan,
      reason: 'tool_result_unexpected',
      availableTools: ['playbook_search', 'get_portfolio'],
    });

    const step1 = revised.plan.steps.find((s) => s.id === '1');
    const step2 = revised.plan.steps.find((s) => s.id === '2');
    expect(step1?.requiresTool).toBe(false);
    expect(step1?.toolName).toBeUndefined();
    expect(step2?.toolName).toBe('playbook_search');
    expect(step2?.toolInput).toEqual({ query: 'HEARTBEAT.md' });
  });
});
