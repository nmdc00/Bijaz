/**
 * Mentat Mode Configuration
 *
 * Deep analysis mode for comprehensive market research and fragility analysis.
 * Extended iterations, full tool access (except trading), requires critic.
 */

import type { ModeConfig } from './types.js';

/**
 * All analysis tools allowed in mentat mode (no trading).
 */
const MENTAT_TOOLS = [
  // Perp market tools (read-only)
  'perp_market_list',
  'perp_market_get',
  'perp_positions',
  'perp_analyze',
  'position_analysis',
  'discovery_report',
  'discovery_select_markets',
  'trade_review',

  // Intel tools
  'intel_search',
  'intel.search',
  'intel_recent',
  'twitter_search',
  'proactive_search_run',
  'comments.get',

  // Memory tools
  'calibration_stats',
  'memory.query',
  'agent_incidents_recent',
  'playbook_search',
  'playbook_get',

  // Web tools
  'web_search',
  'web.search',
  'web_fetch',

  // System tools
  'current_time',
  'get_wallet_info',
  'calculator',
  'system_exec',
  'system_install',
  'tools_list',
  'tools.list',

  // Portfolio analysis (no trading)
  'get_portfolio',
  'get_positions',
  'signal_price_vol_regime',
  'signal_cross_asset_divergence',
  'signal_hyperliquid_funding_oi_skew',
  'signal_hyperliquid_orderflow_imbalance',
  'hyperliquid_verify_live',

  // Funding probes (read-only)
  'evm_erc20_balance',
  'evm_usdc_balances',

  // No trade.place - mentat mode is analysis only
];

/**
 * Mentat mode configuration.
 * Note: maxIterations and temperature can be overridden in config.yaml under agent.modes.mentat
 */
export const mentatMode: ModeConfig = {
  name: 'mentat',
  description: 'Deep analysis mode for comprehensive research and fragility analysis. No trading.',
  allowedTools: MENTAT_TOOLS,
  maxIterations: 20, // Increased from 12 - deep analysis shouldn't be constrained
  requireCritic: true, // Critic for analysis quality
  requireConfirmation: false, // No trades, no confirmation needed
  minConfidence: 0.0, // Analysis can proceed at any confidence
  temperature: 0.5, // Balanced for thoughtful analysis
};
