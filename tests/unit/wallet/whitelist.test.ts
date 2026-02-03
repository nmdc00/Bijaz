/**
 * Whitelist Tests
 *
 * CRITICAL: These tests verify the security of the address whitelist.
 * All tests MUST pass before any deployment.
 */

import { describe, it, expect } from 'vitest';
import {
  isWhitelisted,
  assertWhitelisted,
  WhitelistError,
  AUGUR_WHITELIST,
  getWhitelistedAddresses,
} from '../../../src/execution/wallet/whitelist.js';

describe('Address Whitelist', () => {
  describe('isWhitelisted', () => {
    it('should return true for whitelisted Augur AMM factory', () => {
      expect(
        isWhitelisted('0x79c3cf0553b6852890e8ba58878a5bca8b06d90c')
      ).toBe(true);
    });

    it('should return true for whitelisted addresses (case insensitive)', () => {
      // Uppercase
      expect(
        isWhitelisted('0x79C3CF0553B6852890E8BA58878A5BCA8B06D90C')
      ).toBe(true);

      // Lowercase
      expect(
        isWhitelisted('0x79c3cf0553b6852890e8ba58878a5bca8b06d90c')
      ).toBe(true);

      // Mixed case
      expect(
        isWhitelisted('0x79c3cf0553b6852890E8ba58878A5bCA8b06d90c')
      ).toBe(true);
    });

    it('should return true for all whitelisted addresses', () => {
      for (const addr of AUGUR_WHITELIST) {
        expect(isWhitelisted(addr)).toBe(true);
      }
    });

    it('should return false for non-whitelisted addresses', () => {
      // Random valid Ethereum address
      expect(
        isWhitelisted('0x1234567890123456789012345678901234567890')
      ).toBe(false);

      // Zero address
      expect(
        isWhitelisted('0x0000000000000000000000000000000000000000')
      ).toBe(false);

      // Another random address
      expect(
        isWhitelisted('0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef')
      ).toBe(false);
    });

    it('should return false for invalid addresses', () => {
      // Too short
      expect(isWhitelisted('0x1234')).toBe(false);

      // Too long
      expect(
        isWhitelisted('0x12345678901234567890123456789012345678901234')
      ).toBe(false);

      // No 0x prefix
      expect(
        isWhitelisted('4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E')
      ).toBe(false);

      // Invalid characters
      expect(
        isWhitelisted('0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG')
      ).toBe(false);
    });

    it('should return false for null/undefined/empty', () => {
      expect(isWhitelisted('')).toBe(false);
      expect(isWhitelisted(null as unknown as string)).toBe(false);
      expect(isWhitelisted(undefined as unknown as string)).toBe(false);
    });

    it('should handle whitespace', () => {
      // With leading/trailing whitespace - should still work
      expect(
        isWhitelisted('  0x79c3cf0553b6852890e8ba58878a5bca8b06d90c  ')
      ).toBe(true);
    });
  });

  describe('assertWhitelisted', () => {
    it('should not throw for whitelisted addresses', () => {
      expect(() => {
        assertWhitelisted('0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E');
      }).not.toThrow();
    });

    it('should throw WhitelistError for non-whitelisted addresses', () => {
      expect(() => {
        assertWhitelisted('0x1234567890123456789012345678901234567890');
      }).toThrow(WhitelistError);
    });

    it('should include context in error message', () => {
      expect(() => {
        assertWhitelisted(
          '0x1234567890123456789012345678901234567890',
          'trade execution'
        );
      }).toThrow(/trade execution/);
    });
  });

  describe('AUGUR_WHITELIST', () => {
    it('should be frozen (immutable)', () => {
      expect(Object.isFrozen(AUGUR_WHITELIST)).toBe(true);
    });

    it('should contain expected number of addresses', () => {
      // Update this if whitelist changes
      expect(AUGUR_WHITELIST.length).toBe(7);
    });

    it('should contain only valid Ethereum addresses', () => {
      const addressRegex = /^0x[a-f0-9]{40}$/;
      for (const addr of AUGUR_WHITELIST) {
        expect(addr).toMatch(addressRegex);
      }
    });

    it('should contain the USDC address', () => {
      expect(
        AUGUR_WHITELIST.includes(
          '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
        )
      ).toBe(true);
    });
  });

  describe('getWhitelistedAddresses', () => {
    it('should return a copy of the whitelist', () => {
      const addresses = getWhitelistedAddresses();
      expect(addresses).toEqual(AUGUR_WHITELIST);
      expect(addresses).not.toBe(AUGUR_WHITELIST);
    });
  });

  describe('Security invariants', () => {
    it('should NOT allow external wallet addresses', () => {
      // Common attack: try to withdraw to attacker's wallet
      const attackerWallets = [
        '0x742d35Cc6634C0532925a3b844Bc9e7595f5a123', // Random
        '0xA0b86a33E6E3BCEf67F16F9e8f55f4c1d6a88888', // Random
        '0xBinance123456789012345678901234567890ab', // Exchange-like
      ];

      for (const wallet of attackerWallets) {
        expect(isWhitelisted(wallet)).toBe(false);
      }
    });

    it('should NOT allow near-miss addresses (off by one character)', () => {
      // Original: 0x79c3cf0553b6852890e8ba58878a5bca8b06d90c
      const nearMisses = [
        '0x79c3cf0553b6852890e8ba58878a5bca8b06d90d', // Last char different
        '0x69c3cf0553b6852890e8ba58878a5bca8b06d90c', // First char different
        '0x79c3cf0553b6852890e8ba58878a5bca8b06d900', // Different ending
      ];

      for (const addr of nearMisses) {
        expect(isWhitelisted(addr)).toBe(false);
      }
    });
  });
});
