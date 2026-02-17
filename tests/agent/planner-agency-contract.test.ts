import { describe, expect, it } from 'vitest';

import { createPlan } from '../../src/agent/planning/planner.js';

describe('planner ownership contract', () => {
  it('includes autonomous ownership guidance when perp_place_order is available', async () => {
    const captured: Array<{ role: string; content: string }> = [];
    const llm = {
      complete: async (messages: Array<{ role: string; content: string }>) => {
        captured.push(...messages);
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
            confidence: 0.8,
            blockers: [],
            reasoning: 'trade',
            warnings: [],
          }),
        };
      },
    };

    await createPlan(llm as any, {
      goal: 'Trade BTC now',
      availableTools: ['perp_place_order', 'get_portfolio'],
    });

    const systemPrompt = captured.find((m) => m.role === 'system')?.content ?? '';
    const userPrompt = captured.find((m) => m.role === 'user')?.content ?? '';
    expect(systemPrompt).toContain('Operator Ownership');
    expect(userPrompt).toContain('Plan from operator ownership');
  });
});
