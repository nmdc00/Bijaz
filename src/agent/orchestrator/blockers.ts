import type { ToolExecution } from '../tools/types.js';
import type { AgentBlockerKind } from '../../memory/incidents.js';

export interface DetectedBlocker {
  kind: AgentBlockerKind;
  summary: string;
  evidence: string;
  suggestedNextSteps: string[];
  playbookKey?: string;
}

function normalizeError(execution: ToolExecution): string {
  if (execution.result && typeof execution.result === 'object') {
    const r = execution.result as any;
    if (r && r.success === false && typeof r.error === 'string') return r.error;
  }
  return '';
}

export function detectBlockers(execution: ToolExecution): DetectedBlocker[] {
  const error = normalizeError(execution);
  if (!error) return [];

  const tool = execution.toolName;
  const msg = error.toLowerCase();

  const blockers: DetectedBlocker[] = [];

  // Hyperliquid signer/account preconditions.
  if (
    (
      tool === 'perp_positions' ||
      tool === 'perp_open_orders' ||
      tool === 'get_open_orders' ||
      tool === 'perp_place_order'
    ) &&
    (msg.includes('private key not configured') ||
      msg.includes('missing hyperliquid_private_key') ||
      msg.includes('hyperliquid private key'))
  ) {
    blockers.push({
      kind: 'hyperliquid_missing_signer',
      summary: 'Missing Hyperliquid signer (private key).',
      evidence: error,
      suggestedNextSteps: [
        'Set HYPERLIQUID_PRIVATE_KEY (and optionally HYPERLIQUID_ACCOUNT_ADDRESS) in the runtime environment.',
        'Run: thufir env verify-live --symbol BTC',
      ],
      playbookKey: 'hyperliquid/signer-setup',
    });
  }

  if (
    (tool === 'perp_positions' || tool === 'perp_open_orders' || tool === 'get_open_orders') &&
    (msg.includes('account address not configured') ||
      msg.includes('hyperliquid account address not configured'))
  ) {
    blockers.push({
      kind: 'hyperliquid_missing_account',
      summary: 'Missing Hyperliquid account address.',
      evidence: error,
      suggestedNextSteps: [
        'Set HYPERLIQUID_ACCOUNT_ADDRESS, or ensure it is derivable from HYPERLIQUID_PRIVATE_KEY.',
        'Run: thufir env verify-live --symbol BTC',
      ],
      playbookKey: 'hyperliquid/account-setup',
    });
  }

  // Funding/collateral issues (common blocker for first live trade).
  if (
    tool === 'perp_place_order' &&
    (msg.includes('insufficient') ||
      msg.includes('margin') ||
      msg.includes('collateral') ||
      msg.includes('withdrawable') ||
      msg.includes('not enough'))
  ) {
    blockers.push({
      kind: 'hyperliquid_insufficient_collateral',
      summary: 'Insufficient Hyperliquid collateral/margin to place the order.',
      evidence: error,
      suggestedNextSteps: [
        'Check Hyperliquid account state (collateral/withdrawable) via perp_positions.',
        'If collateral is low/zero, deposit USDC via the Hyperliquid bridge path, then re-check and retry.',
      ],
      playbookKey: 'hyperliquid/funding',
    });
  }

  // Generic transient issue class.
  if (
    msg.includes('timeout') ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up')
  ) {
    blockers.push({
      kind: 'network_or_rate_limit',
      summary: 'Transient network/rate-limit error.',
      evidence: error,
      suggestedNextSteps: [
        'Retry with backoff.',
        'If persistent, switch provider/base URL or reduce tool frequency.',
      ],
    });
  }

  return blockers;
}

export function seedPlaybookForBlocker(kind: AgentBlockerKind): {
  key: string;
  title: string;
  content: string;
  tags: string[];
} | null {
  switch (kind) {
    case 'hyperliquid_missing_signer':
      return {
        key: 'hyperliquid/signer-setup',
        title: 'Hyperliquid Signer Setup',
        tags: ['hyperliquid', 'credentials', 'trading'],
        content: [
          'Goal: enable authenticated Hyperliquid actions (orders/cancel/open orders).',
          '',
          'Checklist:',
          '- Set HYPERLIQUID_PRIVATE_KEY in environment (0x-prefixed hex).',
          '- Optional: set HYPERLIQUID_ACCOUNT_ADDRESS (must match private key derived address).',
          '- Run: thufir env verify-live --symbol BTC',
          '',
          'Verification:',
          '- Account state loads (clearinghouseState).',
          '- Open orders loads (even empty).',
        ].join('\n'),
      };
    case 'hyperliquid_missing_account':
      return {
        key: 'hyperliquid/account-setup',
        title: 'Hyperliquid Account Address Setup',
        tags: ['hyperliquid', 'credentials'],
        content: [
          'Goal: make Hyperliquid account address resolvable for info queries.',
          '',
          'Checklist:',
          '- Prefer: set HYPERLIQUID_PRIVATE_KEY and let address derive automatically.',
          '- Or: set HYPERLIQUID_ACCOUNT_ADDRESS explicitly (0x...).',
          '',
          'Verification:',
          '- Run: thufir env verify-live --symbol BTC',
          '- Ensure account state loads for the expected address prefix.',
        ].join('\n'),
      };
    case 'hyperliquid_insufficient_collateral':
      return {
        key: 'hyperliquid/funding',
        title: 'Funding Hyperliquid Collateral (USDC)',
        tags: ['hyperliquid', 'funding', 'usdc'],
        content: [
          'Symptom:',
          '- Order placement fails with insufficient margin/collateral.',
          '',
          'Diagnosis:',
          '- Query clearinghouse state (perp_positions) and confirm withdrawable/collateral.',
          '- Check chain balances (polygon/arbitrum) for native USDC and gas.',
          '',
          'Fix:',
          '- If USDC is on Polygon, bridge it to Arbitrum (CCTP) or via your preferred bridge.',
          '- Deposit Arbitrum USDC into Hyperliquid by transferring to the Hyperliquid bridge deposit address.',
          '- After deposit, re-run clearinghouse state and confirm withdrawable > 0.',
          '',
          'Verification:',
          '- Run an authenticated order roundtrip: place a tiny far-off limit order, see it in open orders, cancel it.',
        ].join('\n'),
      };
    default:
      return null;
  }
}

export function suggestedRemediationToolSteps(kind: AgentBlockerKind): Array<{
  description: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}> {
  switch (kind) {
    case 'hyperliquid_missing_signer':
    case 'hyperliquid_missing_account':
      return [
        {
          description: 'Run Hyperliquid live verification (auth + account + open orders + signer)',
          toolName: 'hyperliquid_verify_live',
          toolInput: { symbol: 'BTC' },
        },
        {
          description: 'Load playbook for Hyperliquid signer/account setup',
          toolName: 'playbook_get',
          toolInput: { key: kind === 'hyperliquid_missing_signer' ? 'hyperliquid/signer-setup' : 'hyperliquid/account-setup' },
        },
      ];
    case 'hyperliquid_insufficient_collateral':
      return [
        {
          description: 'Check USDC balances on Polygon and Arbitrum for the configured wallet',
          toolName: 'evm_usdc_balances',
          toolInput: {},
        },
        {
          description: 'Fetch Hyperliquid account state (collateral/withdrawable)',
          toolName: 'perp_positions',
          toolInput: {},
        },
        {
          description: 'Load playbook for funding Hyperliquid collateral',
          toolName: 'playbook_get',
          toolInput: { key: 'hyperliquid/funding' },
        },
        {
          description: 'Bridge a small amount of USDC from Polygon to Arbitrum via CCTP (if needed)',
          toolName: 'cctp_bridge_usdc',
          toolInput: { from_chain: 'polygon', to_chain: 'arbitrum', amount_usdc: 10 },
        },
        {
          description: 'Deposit USDC to Hyperliquid bridge address on Arbitrum',
          toolName: 'hyperliquid_deposit_usdc',
          toolInput: { amount_usdc: 10 },
        },
        {
          description: 'Re-run Hyperliquid live verification after deposit',
          toolName: 'hyperliquid_verify_live',
          toolInput: { symbol: 'BTC' },
        },
      ];
    default:
      return [];
  }
}
