import { describe, expect, it } from 'vitest';
import {
  resolveNonCriticalReasonCooldownMs,
  shouldSuppressNonCriticalFallback,
} from '../../src/core/llm.js';

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
});
