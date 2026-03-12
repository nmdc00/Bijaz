import { describe, expect, it, vi } from 'vitest';
import {
  FallbackLlmClient,
  resolveNonCriticalReasonCooldownMs,
  shouldSuppressNonCriticalFallback,
} from '../../src/core/llm.js';
import { withExecutionContext } from '../../src/core/llm_infra.js';

const config = {
  agent: {
    nonCriticalFallbackSuppressReasons: ['info_digest', 'proactive_query_refine'],
    nonCriticalReasonCooldownSeconds: {
      infoDigest: 10,
      sessionCompaction: 300,
      proactiveQueryRefine: 60,
      proactiveFollowUpQueries: 45,
    },
  },
} as any;

describe('LLM non-critical controls', () => {
  it('suppresses fallback for configured non-critical reasons', () => {
    expect(shouldSuppressNonCriticalFallback(config, 'info_digest')).toBe(true);
    expect(shouldSuppressNonCriticalFallback(config, 'session_compaction')).toBe(false);
    expect(shouldSuppressNonCriticalFallback(config, undefined)).toBe(false);
  });

  it('resolves reason cooldown windows in milliseconds', () => {
    expect(resolveNonCriticalReasonCooldownMs(config, 'info_digest')).toBe(10_000);
    expect(resolveNonCriticalReasonCooldownMs(config, 'session_compaction')).toBe(300_000);
    expect(resolveNonCriticalReasonCooldownMs(config, 'proactive_query_refine')).toBe(60_000);
    expect(resolveNonCriticalReasonCooldownMs(config, 'proactive_follow_up_queries')).toBe(45_000);
    expect(resolveNonCriticalReasonCooldownMs(config, 'unknown_reason')).toBe(0);
  });

  it('preemptively skips local trivial calls for suppressed non-critical reasons', async () => {
    const primary = {
      meta: { provider: 'local', model: 'qwen2.5:1.5b-instruct', kind: 'trivial' },
      complete: vi.fn(async () => ({ content: 'primary', model: 'qwen2.5:1.5b-instruct' })),
    };
    const fallback = {
      meta: { provider: 'openai', model: 'gpt-5.1', kind: 'trivial' },
      complete: vi.fn(async () => ({ content: 'fallback', model: 'gpt-5.1' })),
    };
    const client = new FallbackLlmClient(primary as any, fallback as any, () => true, config);

    await expect(
      withExecutionContext(
        { mode: 'LIGHT_REASONING', critical: false, reason: 'info_digest', source: 'conversation' },
        () => client.complete([{ role: 'user', content: 'ping' }])
      )
    ).rejects.toThrow(/skipped/i);

    expect(primary.complete).not.toHaveBeenCalled();
    expect(fallback.complete).not.toHaveBeenCalled();
  });
});
