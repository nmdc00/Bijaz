import { describe, expect, it } from 'vitest';
import { EscalationPolicyEngine } from '../../src/gateway/escalation.js';

describe('EscalationPolicyEngine', () => {
  it('derives a stable dedupe key from source and reason when not provided', () => {
    const policy = new EscalationPolicyEngine({
      enabled: true,
      channels: ['telegram'],
      dedupeWindowSeconds: 30,
      cooldownSeconds: 0,
    });

    const decision = policy.evaluate({
      source: 'worker:hourly',
      reason: 'risk_breach',
      severity: 'warning',
      summary: 'Drawdown nearing threshold',
    });

    expect(decision.shouldSend).toBe(true);
    expect(decision.dedupeKey).toBe('worker:hourly:risk_breach');
  });

  it('suppresses duplicate alerts within dedupe window', () => {
    let nowMs = 1_000;
    const policy = new EscalationPolicyEngine(
      {
        enabled: true,
        channels: ['telegram'],
        dedupeWindowSeconds: 30,
        cooldownSeconds: 0,
      },
      () => nowMs
    );

    const first = policy.evaluate({
      source: 'mentat:default',
      reason: 'high_conviction_setup',
      severity: 'high',
      dedupeKey: 'mentat:default',
      summary: 'Signal crossed threshold',
    });
    expect(first.shouldSend).toBe(true);

    nowMs = 20_000;
    const second = policy.evaluate({
      source: 'mentat:default',
      reason: 'high_conviction_setup',
      severity: 'high',
      dedupeKey: 'mentat:default',
      summary: 'Signal crossed threshold',
    });
    expect(second.shouldSend).toBe(false);
    expect(second.suppressionReason).toBe('dedupe');
  });

  it('enforces cooldown windows for repeated policy keys', () => {
    let nowMs = 5_000;
    const policy = new EscalationPolicyEngine(
      {
        enabled: true,
        channels: ['telegram'],
        dedupeWindowSeconds: 0,
        cooldownSeconds: 60,
      },
      () => nowMs
    );

    const first = policy.evaluate({
      source: 'mentat:hourly',
      reason: 'high_conviction_setup',
      severity: 'critical',
      dedupeKey: 'mentat:hourly',
      summary: 'Fragility 92%',
    });
    expect(first.shouldSend).toBe(true);

    nowMs = 30_000;
    const cooldownHit = policy.evaluate({
      source: 'mentat:hourly',
      reason: 'high_conviction_setup',
      severity: 'critical',
      dedupeKey: 'mentat:hourly',
      summary: 'Fragility 96%',
    });
    expect(cooldownHit.shouldSend).toBe(false);
    expect(cooldownHit.suppressionReason).toBe('cooldown');

    nowMs = 70_000;
    const afterWindow = policy.evaluate({
      source: 'mentat:hourly',
      reason: 'high_conviction_setup',
      severity: 'critical',
      dedupeKey: 'mentat:hourly',
      summary: 'Fragility 97%',
    });
    expect(afterWindow.shouldSend).toBe(true);
  });

  it('routes channels by severity and embeds severity/reason taxonomy in message', () => {
    const policy = new EscalationPolicyEngine({
      enabled: true,
      channels: ['whatsapp'],
      severityChannels: {
        critical: ['telegram', 'whatsapp'],
      },
    });

    const decision = policy.evaluate({
      source: 'mentat:daily',
      reason: 'high_conviction_setup',
      severity: 'critical',
      summary: 'Fragility 95% and delta 32%',
    });

    expect(decision.shouldSend).toBe(true);
    expect(decision.channels).toEqual(['telegram', 'whatsapp']);
    expect(decision.message).toContain('Severity: CRITICAL');
    expect(decision.message).toContain('Reason: high_conviction_setup');
  });

  it('simulates repeated incidents with one send and many suppressions across dedupe/cooldown', () => {
    let nowMs = 0;
    const policy = new EscalationPolicyEngine(
      {
        enabled: true,
        channels: ['telegram'],
        dedupeWindowSeconds: 15,
        cooldownSeconds: 90,
      },
      () => nowMs
    );

    const incidents = [
      { at: 0, summary: 'Fragility 90%' },
      { at: 5_000, summary: 'Fragility 90%' },
      { at: 20_000, summary: 'Fragility 92%' },
      { at: 40_000, summary: 'Fragility 95%' },
      { at: 80_000, summary: 'Fragility 97%' },
    ];

    const decisions = incidents.map((incident) => {
      nowMs = incident.at;
      return policy.evaluate({
        source: 'mentat:default',
        reason: 'high_conviction_setup',
        severity: 'high',
        dedupeKey: 'mentat:default',
        summary: incident.summary,
      });
    });

    const sentCount = decisions.filter((decision) => decision.shouldSend).length;
    const suppressionReasons = decisions
      .filter((decision) => !decision.shouldSend)
      .map((decision) => decision.suppressionReason);

    expect(sentCount).toBe(1);
    expect(suppressionReasons).toEqual(['dedupe', 'cooldown', 'cooldown', 'cooldown']);
  });

  it('falls back to global channels when severity-specific channels are not configured', () => {
    const policy = new EscalationPolicyEngine({
      enabled: true,
      channels: ['TELEGRAM', 'telegram', 'whatsapp'],
      severityChannels: {
        critical: ['pagerduty'],
      },
    });

    const warningDecision = policy.evaluate({
      source: 'worker:daily',
      reason: 'abnormal_slippage',
      severity: 'warning',
      summary: 'Slippage exceeded target',
    });
    expect(warningDecision.shouldSend).toBe(true);
    expect(warningDecision.channels).toEqual(['telegram', 'whatsapp']);

    const criticalDecision = policy.evaluate({
      source: 'worker:daily',
      reason: 'abnormal_slippage',
      severity: 'critical',
      dedupeKey: 'worker:daily:critical',
      summary: 'Critical slippage event',
    });
    expect(criticalDecision.shouldSend).toBe(true);
    expect(criticalDecision.channels).toEqual(['pagerduty']);
  });
});
