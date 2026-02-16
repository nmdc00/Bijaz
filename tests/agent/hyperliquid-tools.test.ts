import { describe, it, expect } from 'vitest';

import { hyperliquidTools } from '../../src/agent/tools/adapters/hyperliquid-tools.js';

describe('hyperliquid tools', () => {
  it('includes usd class transfer tool', () => {
    const names = hyperliquidTools.map((t) => t.name);
    expect(names).toContain('hyperliquid_usd_class_transfer');
  });
});

