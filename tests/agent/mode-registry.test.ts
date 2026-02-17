import { describe, expect, it } from 'vitest';

import { detectMode } from '../../src/agent/modes/registry.js';

describe('mode detection', () => {
  it('routes retrospective trade questions to mentat mode', () => {
    const result = detectMode('Why did you close the previous long?');
    expect(result.mode).toBe('mentat');
  });

  it('routes loss complaints to mentat mode', () => {
    const result = detectMode("You're losing money now dude");
    expect(result.mode).toBe('mentat');
  });

  it('keeps explicit execution requests in trade mode', () => {
    const result = detectMode('Buy BTC now');
    expect(result.mode).toBe('trade');
  });
});
