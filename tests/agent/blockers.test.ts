import { describe, expect, it } from 'vitest';

import { detectBlockers } from '../../src/agent/orchestrator/blockers.js';

describe('detectBlockers', () => {
  it('classifies get_open_orders signer failures as hyperliquid_missing_signer', () => {
    const blockers = detectBlockers({
      toolName: 'get_open_orders',
      input: {},
      result: {
        success: false,
        error: 'Hyperliquid private key not configured',
      },
      timestamp: new Date().toISOString(),
      durationMs: 1,
      cached: false,
    });

    expect(blockers.some((b) => b.kind === 'hyperliquid_missing_signer')).toBe(true);
  });
});
