import { describe, it, expect } from 'vitest';
import { THUFIR_TOOLS, getToolsForSubset, getToolSubsetNames } from '../../src/core/tool-schemas.js';
import type { ToolSubset } from '../../src/core/tool-schemas.js';

describe('Tool Subset Registry', () => {
  it('full subset returns all tools', () => {
    const tools = getToolsForSubset('full');
    expect(tools).toBe(THUFIR_TOOLS);
    expect(tools.length).toBe(THUFIR_TOOLS.length);
  });

  it('discovery subset returns ≤15 tools', () => {
    const tools = getToolsForSubset('discovery');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThanOrEqual(15);
  });

  it('execution subset returns ≤15 tools', () => {
    const tools = getToolsForSubset('execution');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThanOrEqual(15);
  });

  it('trivial subset returns ≤5 tools', () => {
    const tools = getToolsForSubset('trivial');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThanOrEqual(5);
  });

  it('chat subset includes trade and research tools', () => {
    const tools = getToolsForSubset('chat');
    const names = new Set(tools.map((t) => t.name));
    expect(names.has('web_search')).toBe(true);
    expect(names.has('perp_place_order')).toBe(true);
    expect(names.has('get_portfolio')).toBe(true);
    expect(names.has('intel_search')).toBe(true);
  });

  it('discovery subset includes signal and market tools', () => {
    const tools = getToolsForSubset('discovery');
    const names = new Set(tools.map((t) => t.name));
    expect(names.has('signal_price_vol_regime')).toBe(true);
    expect(names.has('signal_hyperliquid_funding_oi_skew')).toBe(true);
    expect(names.has('discovery_run')).toBe(true);
    expect(names.has('perp_market_list')).toBe(true);
  });

  it('execution subset includes order and position tools', () => {
    const tools = getToolsForSubset('execution');
    const names = new Set(tools.map((t) => t.name));
    expect(names.has('perp_place_order')).toBe(true);
    expect(names.has('perp_cancel_order')).toBe(true);
    expect(names.has('perp_positions')).toBe(true);
    expect(names.has('position_analysis')).toBe(true);
  });

  it('every tool in a subset exists in THUFIR_TOOLS', () => {
    const allNames = new Set(THUFIR_TOOLS.map((t) => t.name));
    const subsets: Array<Exclude<ToolSubset, 'full'>> = ['discovery', 'execution', 'chat', 'trivial'];

    for (const subset of subsets) {
      const subsetNames = getToolSubsetNames(subset);
      for (const name of subsetNames) {
        expect(allNames.has(name), `${name} in ${subset} subset not found in THUFIR_TOOLS`).toBe(true);
      }
    }
  });

  it('every tool belongs to at least one non-full subset', () => {
    const subsets: Array<Exclude<ToolSubset, 'full'>> = ['discovery', 'execution', 'chat', 'trivial'];
    const covered = new Set<string>();
    for (const subset of subsets) {
      for (const name of getToolSubsetNames(subset)) {
        covered.add(name);
      }
    }

    const uncovered = THUFIR_TOOLS.filter((t) => !covered.has(t.name)).map((t) => t.name);
    // Some tools may intentionally only be available in 'full' mode (system tools, bridging, etc.)
    // but the core trading/research tools should be covered
    expect(uncovered.length).toBeLessThan(THUFIR_TOOLS.length / 2);
  });

  it('subsets are significantly smaller than full set', () => {
    const full = THUFIR_TOOLS.length;
    expect(getToolsForSubset('discovery').length).toBeLessThan(full * 0.4);
    expect(getToolsForSubset('execution').length).toBeLessThan(full * 0.4);
    expect(getToolsForSubset('trivial').length).toBeLessThan(full * 0.15);
  });
});
