export type EscalationSeverity = 'info' | 'warning' | 'high' | 'critical';

export type EscalationReason =
  | 'risk_breach'
  | 'stop_failure'
  | 'abnormal_slippage'
  | 'high_conviction_setup';

export interface EscalationEvent {
  source: string;
  summary: string;
  reason: EscalationReason;
  severity: EscalationSeverity;
  dedupeKey?: string;
  message?: string;
  occurredAtMs?: number;
}

export interface EscalationPolicyConfig {
  enabled?: boolean;
  channels?: string[];
  actionableReasons?: EscalationReason[];
  dedupeWindowSeconds?: number;
  cooldownSeconds?: number;
  severityChannels?: Partial<Record<EscalationSeverity, string[]>>;
}

type SuppressionReason = 'disabled' | 'non_actionable' | 'dedupe' | 'cooldown' | 'no_channels';

export interface EscalationDecision {
  shouldSend: boolean;
  suppressionReason?: SuppressionReason;
  channels: string[];
  message: string;
  dedupeKey: string;
}

interface EscalationState {
  lastSeenAtMs: number;
  lastSentAtMs: number;
  lastFingerprint: string;
}

interface NormalizedEscalationPolicy {
  enabled: boolean;
  channels: string[];
  actionableReasons: EscalationReason[];
  dedupeWindowSeconds: number;
  cooldownSeconds: number;
  severityChannels: Record<EscalationSeverity, string[]>;
}

const DEFAULT_ACTIONABLE_REASONS: EscalationReason[] = [
  'risk_breach',
  'stop_failure',
  'abnormal_slippage',
  'high_conviction_setup',
];

function normalizeChannels(channels: string[] | undefined): string[] {
  if (!channels || channels.length === 0) return [];
  const seen = new Set<string>();
  for (const channel of channels) {
    const key = String(channel ?? '')
      .trim()
      .toLowerCase();
    if (!key) continue;
    seen.add(key);
  }
  return [...seen];
}

export class EscalationPolicyEngine {
  private state = new Map<string, EscalationState>();
  private now: () => number;
  private normalized: NormalizedEscalationPolicy;

  constructor(config: EscalationPolicyConfig | undefined, now: () => number = () => Date.now()) {
    this.now = now;
    this.normalized = {
      enabled: config?.enabled ?? false,
      channels: normalizeChannels(config?.channels),
      actionableReasons: (config?.actionableReasons?.length
        ? config.actionableReasons
        : DEFAULT_ACTIONABLE_REASONS) as EscalationReason[],
      dedupeWindowSeconds: Math.max(0, Number(config?.dedupeWindowSeconds ?? 300) || 300),
      cooldownSeconds: Math.max(0, Number(config?.cooldownSeconds ?? 900) || 900),
      severityChannels: {
        info: normalizeChannels(config?.severityChannels?.info),
        warning: normalizeChannels(config?.severityChannels?.warning),
        high: normalizeChannels(config?.severityChannels?.high),
        critical: normalizeChannels(config?.severityChannels?.critical),
      },
    };
  }

  evaluate(event: EscalationEvent): EscalationDecision {
    const dedupeKey = event.dedupeKey ?? `${event.source}:${event.reason}`;
    const message = this.formatMessage(event);
    const fail = (suppressionReason: SuppressionReason): EscalationDecision => ({
      shouldSend: false,
      suppressionReason,
      channels: [],
      message,
      dedupeKey,
    });

    if (!this.normalized.enabled) {
      return fail('disabled');
    }
    if (!this.normalized.actionableReasons.includes(event.reason)) {
      return fail('non_actionable');
    }

    const severityChannels = this.normalized.severityChannels[event.severity];
    const channels = severityChannels.length > 0 ? severityChannels : this.normalized.channels;
    if (channels.length === 0) {
      return fail('no_channels');
    }

    const now = event.occurredAtMs ?? this.now();
    const fingerprint = `${event.reason}|${event.severity}|${event.summary.trim()}`;
    const existing = this.state.get(dedupeKey);
    if (existing) {
      const dedupeWindowMs = this.normalized.dedupeWindowSeconds * 1000;
      if (
        dedupeWindowMs > 0 &&
        existing.lastFingerprint === fingerprint &&
        now - existing.lastSeenAtMs < dedupeWindowMs
      ) {
        existing.lastSeenAtMs = now;
        this.state.set(dedupeKey, existing);
        return fail('dedupe');
      }

      const cooldownMs = this.normalized.cooldownSeconds * 1000;
      if (cooldownMs > 0 && now - existing.lastSentAtMs < cooldownMs) {
        existing.lastSeenAtMs = now;
        this.state.set(dedupeKey, existing);
        return fail('cooldown');
      }
    }

    this.state.set(dedupeKey, {
      lastSeenAtMs: now,
      lastSentAtMs: now,
      lastFingerprint: fingerprint,
    });

    return {
      shouldSend: true,
      channels,
      message,
      dedupeKey,
    };
  }

  private formatMessage(event: EscalationEvent): string {
    const lines = [
      '🚨 Escalation Alert',
      `Severity: ${event.severity.toUpperCase()}`,
      `Reason: ${event.reason}`,
      `Source: ${event.source}`,
      `Summary: ${event.summary}`,
    ];
    if (event.message && event.message.trim().length > 0) {
      lines.push('', event.message.trim());
    }
    return lines.join('\n');
  }
}
