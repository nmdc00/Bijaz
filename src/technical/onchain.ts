import type { ThufirConfig } from '../core/config.js';
import type { OnChainSnapshot } from './types.js';

export async function getOnChainSnapshot(
  config: ThufirConfig,
  symbol: string
): Promise<OnChainSnapshot> {
  if (!config.technical?.onChain?.enabled) {
    return { score: 0, reasoning: ['On-chain data disabled.'] };
  }

  if (!config.technical?.onChain?.coinglassApiKey) {
    return { score: 0, reasoning: ['Missing COINGLASS_API_KEY; on-chain score neutral.'] };
  }

  // Placeholder: Wire Coinglass endpoints here when configured.
  return {
    score: 0,
    reasoning: [
      `On-chain source configured for ${symbol}, but no providers are wired yet.`,
      'Set up Coinglass endpoints to enable funding/OI/liquidation scoring.',
    ],
  };
}
