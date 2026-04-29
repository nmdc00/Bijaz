import { describe, it, expect, beforeEach } from 'vitest';
import {
  upsertSuppression,
  isSuppressed,
  listActiveSuppressed,
  clearExpired,
} from '../../src/memory/signal_class_suppression.js';

describe('signal_class_suppression', () => {
  beforeEach(() => {
    clearExpired(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  });

  describe('upsertSuppression + isSuppressed', () => {
    it('returns true for a class suppressed into the future', () => {
      const futureMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
      upsertSuppression({ signalClass: 'llm_originator', suppressedUntilMs: futureMs, reason: 'test' });
      expect(isSuppressed('llm_originator')).toBe(true);
    });

    it('returns false for an unknown class', () => {
      expect(isSuppressed('nonexistent_class_xyz')).toBe(false);
    });

    it('returns false after suppression has expired', () => {
      const pastMs = Date.now() - 1000;
      upsertSuppression({ signalClass: 'stale_class', suppressedUntilMs: pastMs, reason: 'expired' });
      expect(isSuppressed('stale_class')).toBe(false);
    });

    it('overwrites existing suppression on upsert', () => {
      const futureMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
      upsertSuppression({ signalClass: 'llm_originator', suppressedUntilMs: futureMs, reason: 'first' });
      upsertSuppression({ signalClass: 'llm_originator', suppressedUntilMs: Date.now() - 1, reason: 'cleared' });
      expect(isSuppressed('llm_originator')).toBe(false);
    });
  });

  describe('listActiveSuppressed', () => {
    it('only returns non-expired entries', () => {
      const now = Date.now();
      upsertSuppression({ signalClass: 'active_class', suppressedUntilMs: now + 100_000, reason: 'active' });
      upsertSuppression({ signalClass: 'expired_class', suppressedUntilMs: now - 1, reason: 'expired' });
      const active = listActiveSuppressed();
      expect(active.some((e) => e.signalClass === 'active_class')).toBe(true);
      expect(active.some((e) => e.signalClass === 'expired_class')).toBe(false);
    });
  });

  describe('clearExpired', () => {
    it('deletes expired entries and returns count', () => {
      const pastMs = Date.now() - 1000;
      upsertSuppression({ signalClass: 'old_class_1', suppressedUntilMs: pastMs, reason: 'test' });
      upsertSuppression({ signalClass: 'old_class_2', suppressedUntilMs: pastMs, reason: 'test' });
      const deleted = clearExpired();
      expect(deleted).toBeGreaterThanOrEqual(2);
      expect(isSuppressed('old_class_1')).toBe(false);
      expect(isSuppressed('old_class_2')).toBe(false);
    });

    it('does not delete active suppressions', () => {
      upsertSuppression({ signalClass: 'keep_me', suppressedUntilMs: Date.now() + 100_000, reason: 'active' });
      clearExpired();
      expect(isSuppressed('keep_me')).toBe(true);
    });
  });
});
