import { describe, expect, it } from 'vitest';

import { createPlan } from '../../src/agent/planning/planner.js';

describe('planner tool availability routing', () => {
  it('remaps known unavailable alias tools to available runtime tools', async () => {
    const result = await createPlan(
      {
        complete: async () => ({
          content: JSON.stringify({
            steps: [
              {
                id: '1',
                description: 'Resolve a symbol first',
                requiresTool: true,
                toolName: 'symbol_resolve',
                toolInput: { query: 'BTC' },
              },
            ],
            confidence: 0.7,
            blockers: [],
            reasoning: 'route through available market list tool',
            warnings: [],
          }),
        }),
      } as any,
      {
        goal: 'analyze BTC',
        availableTools: ['perp_market_list', 'perp_analyze'],
      }
    );

    expect(result.plan.steps[0]?.requiresTool).toBe(true);
    expect(result.plan.steps[0]?.toolName).toBe('perp_market_list');
    expect(result.warnings.some((w) => w.includes('remapped'))).toBe(true);
  });

  it('downgrades unavailable tools to non-tool steps instead of preserving invalid calls', async () => {
    const result = await createPlan(
      {
        complete: async () => ({
          content: JSON.stringify({
            steps: [
              {
                id: '1',
                description: 'Use unsupported router',
                requiresTool: true,
                toolName: 'perp_risk_action_router',
                toolInput: {},
              },
            ],
            confidence: 0.6,
            blockers: [],
            reasoning: 'fallback when missing tool',
            warnings: [],
          }),
        }),
      } as any,
      {
        goal: 'manage risk',
        availableTools: ['get_portfolio'],
      }
    );

    expect(result.plan.steps[0]?.requiresTool).toBe(false);
    expect(result.plan.steps[0]?.toolName).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('downgraded'))).toBe(true);
  });

  it('remaps playbook_get to playbook_search with key->query input adaptation', async () => {
    const result = await createPlan(
      {
        complete: async () => ({
          content: JSON.stringify({
            steps: [
              {
                id: '1',
                description: 'Load heartbeat playbook',
                requiresTool: true,
                toolName: 'playbook_get',
                toolInput: { key: 'HEARTBEAT.md' },
              },
            ],
            confidence: 0.7,
            blockers: [],
            reasoning: 'fallback to search when get is unavailable',
            warnings: [],
          }),
        }),
      } as any,
      {
        goal: 'load heartbeat playbook',
        availableTools: ['playbook_search'],
      }
    );

    expect(result.plan.steps[0]?.requiresTool).toBe(true);
    expect(result.plan.steps[0]?.toolName).toBe('playbook_search');
    expect(result.plan.steps[0]?.toolInput).toEqual({ query: 'HEARTBEAT.md' });
  });
});
