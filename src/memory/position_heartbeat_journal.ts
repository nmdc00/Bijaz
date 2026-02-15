import { storeDecisionArtifact } from './decision_artifacts.js';

export type PositionHeartbeatOutcome = 'ok' | 'failed' | 'rejected' | 'skipped' | 'info';

export type PositionHeartbeatDecision = {
  action:
    | 'hold'
    | 'tighten_stop'
    | 'adjust_take_profit'
    | 'take_partial_profit'
    | 'close_entirely';
  reason: string;
};

export type PositionHeartbeatJournalEntry = {
  kind: 'position_heartbeat_journal';
  symbol: string;
  timestamp: string; // ISO
  triggers: string[];
  decision: PositionHeartbeatDecision;
  outcome: PositionHeartbeatOutcome;
  snapshot?: Record<string, unknown> | null;
  error?: string | null;
};

export function recordPositionHeartbeatDecision(entry: PositionHeartbeatJournalEntry): void {
  storeDecisionArtifact({
    source: 'heartbeat',
    kind: entry.kind,
    marketId: entry.symbol,
    fingerprint: `${entry.symbol}:${entry.timestamp}:${entry.decision.action}`,
    outcome: entry.outcome,
    payload: entry,
  });
}

