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
});
