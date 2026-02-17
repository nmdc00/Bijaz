/**
 * Spending Limits Tests
 *
 * CRITICAL: These tests verify spending limit enforcement.
 * All tests MUST pass before any deployment.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SpendingLimitEnforcer,
  type SpendingLimits,
} from '../../../src/execution/wallet/limits.js';

vi.mock('../../../src/memory/db.js', () => ({
  openDatabase: () => ({
    prepare: () => ({
      get: () => undefined,
      run: () => ({ changes: 1 }),
    }),
  }),
}));

describe('SpendingLimitEnforcer', () => {
  let enforcer: SpendingLimitEnforcer;
  const defaultLimits: SpendingLimits = {
    daily: 100,
    perTrade: 25,
    confirmationThreshold: 10,
  };

  beforeEach(() => {
    enforcer = new SpendingLimitEnforcer(defaultLimits);
  });

  describe('checkAndReserve', () => {
    it('should allow trades under all limits', async () => {
      const result = await enforcer.checkAndReserve(5);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it('should require confirmation for trades above threshold', async () => {
      const result = await enforcer.checkAndReserve(15);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.reason).toContain('requires confirmation');
    });

    it('should reject trades exceeding per-trade limit', async () => {
      const result = await enforcer.checkAndReserve(30);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('exceeds per-trade limit');
    });

    it('should reject trades that would exceed daily limit', async () => {
      // Make several trades to approach limit
      await enforcer.checkAndReserve(20);
      enforcer.confirm(20);

      await enforcer.checkAndReserve(20);
      enforcer.confirm(20);

      await enforcer.checkAndReserve(20);
      enforcer.confirm(20);

      await enforcer.checkAndReserve(20);
      enforcer.confirm(20);

      // This should exceed the daily limit of 100
      const result = await enforcer.checkAndReserve(25);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('exceed daily limit');
    });

    it('should reject zero or negative amounts', async () => {
      let result = await enforcer.checkAndReserve(0);
      expect(result.allowed).toBe(false);

      result = await enforcer.checkAndReserve(-10);
      expect(result.allowed).toBe(false);
    });

    it('should track reserved amounts', async () => {
      await enforcer.checkAndReserve(20);
      await enforcer.checkAndReserve(20);
      await enforcer.checkAndReserve(20);
      await enforcer.checkAndReserve(20);

      // 80 reserved, should not allow another 25
      const result = await enforcer.checkAndReserve(25);
      expect(result.allowed).toBe(false);
    });

    it('should report remaining daily allowance', async () => {
      const result = await enforcer.checkAndReserve(20);

      expect(result.remainingDaily).toBe(80);
    });
  });

  describe('confirm', () => {
    it('should move reserved to spent', async () => {
      await enforcer.checkAndReserve(20);
      enforcer.confirm(20);

      const state = enforcer.getState();
      expect(state.todaySpent).toBe(20);
      expect(state.reserved).toBe(0);
    });

    it('should increment trade count', async () => {
      await enforcer.checkAndReserve(10);
      enforcer.confirm(10);

      await enforcer.checkAndReserve(10);
      enforcer.confirm(10);

      const state = enforcer.getState();
      expect(state.todayTradeCount).toBe(2);
    });
  });

  describe('release', () => {
    it('should release reserved amount', async () => {
      await enforcer.checkAndReserve(20);
      enforcer.release(20);

      const state = enforcer.getState();
      expect(state.reserved).toBe(0);
      expect(state.todaySpent).toBe(0);
    });

    it('should allow the released amount to be used again', async () => {
      // Reserve up to limit
      await enforcer.checkAndReserve(25);
      await enforcer.checkAndReserve(25);
      await enforcer.checkAndReserve(25);
      await enforcer.checkAndReserve(25);

      // Release one
      enforcer.release(25);

      // Should be able to reserve again
      const result = await enforcer.checkAndReserve(25);
      expect(result.allowed).toBe(true);
    });
  });

  describe('getRemainingDaily', () => {
    it('should return correct remaining amount', async () => {
      expect(enforcer.getRemainingDaily()).toBe(100);

      await enforcer.checkAndReserve(20);
      enforcer.confirm(20);

      expect(enforcer.getRemainingDaily()).toBe(80);

      await enforcer.checkAndReserve(25);
      // Reserved but not confirmed
      expect(enforcer.getRemainingDaily()).toBe(55);

      enforcer.release(25);
      expect(enforcer.getRemainingDaily()).toBe(80);
    });
  });

  describe('setLimits', () => {
    it('should update limits', () => {
      enforcer.setLimits({ daily: 200, perTrade: 50 });

      const limits = enforcer.getLimits();
      expect(limits.daily).toBe(200);
      expect(limits.perTrade).toBe(50);
      expect(limits.confirmationThreshold).toBe(10); // Unchanged
    });

    it('should not affect already-spent amounts', async () => {
      await enforcer.checkAndReserve(20);
      enforcer.confirm(20);

      // Lower daily limit below what's already spent
      enforcer.setLimits({ daily: 10 });

      // Already spent 20, but new limit is 10
      // Should not allow more trades
      const result = await enforcer.checkAndReserve(5);
      expect(result.allowed).toBe(false);
    });
  });

  describe('events', () => {
    it('should emit limit-exceeded on per-trade violation', async () => {
      let emitted = false;
      enforcer.on('limit-exceeded', (data) => {
        emitted = true;
        expect(data.type).toBe('per-trade');
        expect(data.attempted).toBe(30);
        expect(data.limit).toBe(25);
      });

      await enforcer.checkAndReserve(30);
      expect(emitted).toBe(true);
    });

    it('should emit limit-exceeded on daily violation', async () => {
      let emitted = false;
      enforcer.on('limit-exceeded', (data) => {
        if (data.type === 'daily') {
          emitted = true;
        }
      });

      // Spend up to limit
      for (let i = 0; i < 5; i++) {
        await enforcer.checkAndReserve(20);
        enforcer.confirm(20);
      }

      // This exceeds daily
      await enforcer.checkAndReserve(20);
      expect(emitted).toBe(true);
    });

    it('should emit limit-warning when approaching daily limit', async () => {
      let emitted = false;
      enforcer.on('limit-warning', () => {
        emitted = true;
      });

      // Spend 85% of daily limit
      await enforcer.checkAndReserve(20);
      enforcer.confirm(20);
      await enforcer.checkAndReserve(20);
      enforcer.confirm(20);
      await enforcer.checkAndReserve(20);
      enforcer.confirm(20);
      await enforcer.checkAndReserve(20);
      enforcer.confirm(20);

      // This brings us to 85, which should trigger warning
      await enforcer.checkAndReserve(5);
      expect(emitted).toBe(true);
    });
  });

  describe('Security invariants', () => {
    it('should NEVER allow trade exceeding per-trade limit', async () => {
      const amounts = [25.01, 26, 50, 100, 1000, 10000];

      for (const amount of amounts) {
        const result = await enforcer.checkAndReserve(amount);
        expect(result.allowed).toBe(false);
      }
    });

    it('should NEVER allow total spend exceeding daily limit', async () => {
      // Confirm trades up to daily limit
      const confirmedTotal = { value: 0 };

      // Try to exceed limit through multiple small trades
      for (let i = 0; i < 20; i++) {
        const result = await enforcer.checkAndReserve(10);
        if (result.allowed) {
          enforcer.confirm(10);
          confirmedTotal.value += 10;
        }
      }

      // Should have stopped at or before 100
      expect(confirmedTotal.value).toBeLessThanOrEqual(100);
    });

    it('should not allow manipulation through reserve/release cycling', async () => {
      // Try to game the system by reserving and releasing repeatedly
      for (let i = 0; i < 10; i++) {
        await enforcer.checkAndReserve(25);
        enforcer.release(25);
      }

      // Actually confirm some trades
      for (let i = 0; i < 4; i++) {
        await enforcer.checkAndReserve(25);
        enforcer.confirm(25);
      }

      // Should now be at limit
      const result = await enforcer.checkAndReserve(5);
      expect(result.allowed).toBe(false);
    });
  });
});
