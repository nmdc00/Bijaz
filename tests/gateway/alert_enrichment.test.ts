import { describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '../../src/core/llm.js';
import { enrichEscalationMessage } from '../../src/gateway/alert_enrichment.js';

function createMockLlm(content: string, delayMs = 0): LlmClient {
  return {
    complete: vi.fn(async () => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return { content, model: 'test-model' };
    }),
  };
}

describe('enrichEscalationMessage', () => {
  const baseInput = {
    baseMessage: 'Escalation Alert\nSeverity: CRITICAL',
    source: 'mentat:hourly',
    reason: 'high_conviction_setup' as const,
    severity: 'critical' as const,
    summary: 'Fragility 95%',
  };

  it('appends LLM context on successful enrichment', async () => {
    const llm = createMockLlm('Volatility regime shift detected. Check funding skew next.');

    const message = await enrichEscalationMessage({
      ...baseInput,
      llm,
      config: { enabled: true, timeoutMs: 100, maxChars: 200 },
    });

    expect(message).toContain(baseInput.baseMessage);
    expect(message).toContain('LLM Context: Volatility regime shift detected.');
  });

  it('falls back to base message on injected exception', async () => {
    const llm = createMockLlm('unused');
    const onFallback = vi.fn();

    const message = await enrichEscalationMessage({
      ...baseInput,
      llm,
      config: { enabled: true, timeoutMs: 100 },
      faultInjectionMode: 'throw',
      onFallback,
    });

    expect(message).toBe(baseInput.baseMessage);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('falls back to base message on injected timeout', async () => {
    const llm = createMockLlm('unused');
    const onFallback = vi.fn();

    const message = await enrichEscalationMessage({
      ...baseInput,
      llm,
      config: { enabled: true, timeoutMs: 20 },
      faultInjectionMode: 'timeout',
      onFallback,
    });

    expect(message).toBe(baseInput.baseMessage);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('still dispatches mechanical critical alert when enrichment is unavailable', async () => {
    const llm = createMockLlm('unused');
    const sent: string[] = [];

    const finalMessage = await enrichEscalationMessage({
      ...baseInput,
      llm,
      config: { enabled: true, timeoutMs: 20 },
      faultInjectionMode: 'throw',
    });
    sent.push(finalMessage);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Escalation Alert');
    expect(sent[0]).toContain('Severity: CRITICAL');
    expect(sent[0]).not.toContain('LLM Context:');
  });
});
