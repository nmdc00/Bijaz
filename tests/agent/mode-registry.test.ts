import { describe, expect, it } from 'vitest';

import { detectMode } from '../../src/agent/modes/registry.js';

describe('detectMode', () => {
  it('stays in chat mode for conversational trade commentary', () => {
    const result = detectMode('your trade is looking very good. Thoughts?');
    expect(result.mode).toBe('chat');
  });

  it('routes pnl walkthrough requests to mentat mode', () => {
    const result = detectMode('Walk me through your pnl and last action taken');
    expect(result.mode).toBe('mentat');
  });

  it('routes last-trade recap requests to mentat mode', () => {
    const result = detectMode('walk me through your last trade and fees');
    expect(result.mode).toBe('mentat');
  });

  it('switches to trade mode for explicit execution requests', () => {
    const result = detectMode('can you place a trade now?');
    expect(result.mode).toBe('trade');
  });

  it('switches to trade mode for direct buy/sell intent', () => {
    const result = detectMode('buy btc now');
    expect(result.mode).toBe('trade');
  });
});
