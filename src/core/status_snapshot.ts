import type { OperatorStatusSnapshot } from './autonomous.js';

const MAX_STATUS_MESSAGE_CHARS = 1200;
const MAX_OPEN_POSITIONS = 3;

function formatSignedUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}

function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `$${value.toFixed(2)}`;
}

function formatIsoOrFallback(value: string | null | undefined, fallback: string): string {
  if (!value || Number.isNaN(Date.parse(value))) return fallback;
  return value;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatOpenPositions(snapshot: OperatorStatusSnapshot): string {
  if (snapshot.openPositions.length === 0) {
    return 'none';
  }
  const rendered = snapshot.openPositions.slice(0, MAX_OPEN_POSITIONS).map((position) => {
    const pnl = formatSignedUsd(position.unrealizedPnlUsd);
    return `${position.marketId} ${position.outcome} exp=${formatUsd(position.exposureUsd)} uPnL=${pnl}`;
  });
  const extraCount = snapshot.openPositions.length - rendered.length;
  if (extraCount > 0) {
    rendered.push(`+${extraCount} more`);
  }
  return rendered.join(' | ');
}

function trimToMaxChars(message: string): string {
  if (message.length <= MAX_STATUS_MESSAGE_CHARS) {
    return message;
  }
  return `${message.slice(0, MAX_STATUS_MESSAGE_CHARS - 3)}...`;
}

export function formatOperatorStatusSnapshot(snapshot: OperatorStatusSnapshot): string {
  const policyParts = [
    `enabled=${snapshot.runtime.enabled ? 'YES' : 'NO'}`,
    `full_auto=${snapshot.runtime.fullAuto ? 'ON' : 'OFF'}`,
    `paused=${snapshot.runtime.isPaused ? `YES${snapshot.runtime.pauseReason ? ` (${snapshot.runtime.pauseReason})` : ''}` : 'NO'}`,
    `observation=${snapshot.policyState.observationOnly ? 'ON' : 'OFF'}`,
    `trade_contract=${snapshot.policyState.tradeContractEnforced ? 'ON' : 'OFF'}`,
    `quality_gate=${snapshot.policyState.decisionQualityGateEnabled ? 'ON' : 'OFF'}`,
  ];
  if (snapshot.policyState.reason) {
    policyParts.push(`reason=${snapshot.policyState.reason}`);
  }

  const lastTrade = snapshot.lastTrade
    ? `${snapshot.lastTrade.marketId} ${snapshot.lastTrade.outcome} pnl=${formatSignedUsd(snapshot.lastTrade.pnlUsd)} @${formatIsoOrFallback(snapshot.lastTrade.timestamp, 'n/a')}`
    : 'none yet';

  const lines = [
    `Status snapshot (${formatIsoOrFallback(snapshot.asOf, new Date().toISOString())})`,
    `Equity: ${formatUsd(snapshot.equityUsd)}`,
    `Open positions: ${formatOpenPositions(snapshot)}`,
    `Policy state: ${policyParts.join(', ')}`,
    `Last trade outcome: ${lastTrade}`,
    `Next scan time: ${formatIsoOrFallback(snapshot.nextScanAt, 'not scheduled')}`,
    `Uptime: ${formatDuration(snapshot.uptimeMs)}`,
    `Daily P&L: ${formatSignedUsd(snapshot.dailyPnl.totalPnl)} (realized ${formatSignedUsd(snapshot.dailyPnl.realizedPnl)}, unrealized ${formatSignedUsd(snapshot.dailyPnl.unrealizedPnl)}, trades ${snapshot.dailyPnl.tradesExecuted})`,
    `Remaining daily budget: ${formatUsd(snapshot.runtime.remainingDaily)}`,
  ];

  return trimToMaxChars(lines.join('\n'));
}

export const STATUS_SNAPSHOT_MAX_CHARS = MAX_STATUS_MESSAGE_CHARS;
