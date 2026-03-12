import { describe, expect, it } from 'vitest';

import { buildMarketContextPlan, inferMarketContextDomain } from '../../src/markets/context.js';

describe('market context planning', () => {
  it('classifies Iran oil prompts as energy', () => {
    expect(inferMarketContextDomain('Could war with Iran push oil higher?')).toBe('energy');
  });

  it('builds domain-specific search queries for energy prompts', () => {
    const plan = buildMarketContextPlan('Could war with Iran push oil higher?');
    expect(plan.domain).toBe('energy');
    expect(plan.requiresDomainSpecificRetrieval).toBe(true);
    expect(plan.symbolHints).toContain('CL');
    expect(plan.searchQueries.some((query) => /Hormuz/i.test(query))).toBe(true);
    expect(plan.includeFundingSignals).toBe(false);
  });
});
