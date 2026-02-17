import { describe, expect, it } from 'vitest';
import { EscalationPolicyEngine } from '../../src/gateway/escalation.js';

describe('EscalationPolicyEngine', () => {
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
});
