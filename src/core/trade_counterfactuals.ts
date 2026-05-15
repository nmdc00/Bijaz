import type { TradeCounterfactualRecord } from './trade_dossier_types.js';

export interface TradeCounterfactualInput {
  requestedSize?: number | null;
  approvedSize?: number | null;
  requestedLeverage?: number | null;
  approvedLeverage?: number | null;
  netRealizedPnlUsd?: number | null;
  capturedR?: number | null;
  gateVerdict?: string | null;
  delayedEntryPenaltyPct?: number | null;
}

function toFinite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function makeRecord(
  counterfactualType: TradeCounterfactualRecord['counterfactualType'],
  summary: string,
  estimatedNetPnlUsd: number | null,
  baselineNetPnlUsd: number | null,
  estimatedRMultiple: number | null,
  confidence: number,
  inputsPayload: Record<string, unknown>
): TradeCounterfactualRecord {
  const valueAddUsd =
    estimatedNetPnlUsd != null && baselineNetPnlUsd != null
      ? baselineNetPnlUsd - estimatedNetPnlUsd
      : null;
  return {
    counterfactualType,
    baselineKind: counterfactualType === 'approved_size' ? 'approved_trade' : 'counterfactual',
    summary,
    score: valueAddUsd != null ? clamp(valueAddUsd / 50, -1, 1) : null,
    estimatedNetPnlUsd,
    estimatedRMultiple,
    valueAddUsd,
    confidence,
    inputsPayload,
    resultPayload: null,
  };
}

export function buildTradeCounterfactuals(input: TradeCounterfactualInput): TradeCounterfactualRecord[] {
  const requestedSize = toFinite(input.requestedSize);
  const approvedSize = toFinite(input.approvedSize);
  const requestedLeverage = toFinite(input.requestedLeverage);
  const approvedLeverage = toFinite(input.approvedLeverage);
  const netRealizedPnlUsd = toFinite(input.netRealizedPnlUsd);
  const capturedR = toFinite(input.capturedR);
  const delayedEntryPenaltyPct = toFinite(input.delayedEntryPenaltyPct) ?? 0.15;
  const rows: TradeCounterfactualRecord[] = [];

  rows.push(
    makeRecord(
      'no_trade',
      'Baseline if the trade had been skipped.',
      0,
      netRealizedPnlUsd,
      0,
      0.6,
      { gateVerdict: input.gateVerdict ?? null }
    )
  );

  if (netRealizedPnlUsd != null && requestedSize != null && approvedSize != null && approvedSize > 0) {
    rows.push(
      makeRecord(
        'full_size',
        'Counterfactual at full requested size.',
        netRealizedPnlUsd * (requestedSize / approvedSize),
        netRealizedPnlUsd,
        capturedR != null ? capturedR * (requestedSize / approvedSize) : null,
        0.7,
        { requestedSize, approvedSize }
      )
    );
  }

  rows.push(
    makeRecord(
      'approved_size',
      'Observed approved size outcome.',
      netRealizedPnlUsd,
      netRealizedPnlUsd,
      capturedR,
      1,
      { approvedSize }
    )
  );

  if (netRealizedPnlUsd != null) {
    rows.push(
      makeRecord(
        'delay_entry',
        'Counterfactual with a later, more confirmed entry.',
        netRealizedPnlUsd * (1 - delayedEntryPenaltyPct),
        netRealizedPnlUsd,
        capturedR != null ? capturedR * (1 - delayedEntryPenaltyPct) : null,
        0.45,
        { delayedEntryPenaltyPct }
      )
    );
    rows.push(
      makeRecord(
        'ttl_exit',
        'Counterfactual using a deterministic TTL exit.',
        netRealizedPnlUsd * 0.9,
        netRealizedPnlUsd,
        capturedR != null ? capturedR * 0.9 : null,
        0.45,
        {}
      )
    );
  }

  if (netRealizedPnlUsd != null && requestedLeverage != null && approvedLeverage != null && approvedLeverage > 0) {
    rows.push(
      makeRecord(
        'leverage_cap',
        'Counterfactual at requested leverage rather than capped leverage.',
        netRealizedPnlUsd * (requestedLeverage / approvedLeverage),
        netRealizedPnlUsd,
        capturedR != null ? capturedR * (requestedLeverage / approvedLeverage) : null,
        0.7,
        { requestedLeverage, approvedLeverage }
      )
    );
  }

  return rows;
}
