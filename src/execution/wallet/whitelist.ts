/**
 * Augur Turbo Address Whitelist
 *
 * CRITICAL SECURITY COMPONENT
 *
 * This file contains the ONLY addresses that Thufir is allowed to interact with.
 * These addresses are HARDCODED and should NEVER be made configurable.
 *
 * Before ANY transaction is signed, the destination address MUST be checked
 * against this whitelist. If not whitelisted, the transaction MUST be rejected.
 */

/**
 * Whitelisted Augur Turbo contract addresses on Polygon.
 *
 * DO NOT MODIFY without thorough security review.
 * DO NOT add arbitrary addresses.
 * DO NOT make this configurable.
 */
export const AUGUR_WHITELIST = Object.freeze([
  // Augur Turbo AMM Factory
  '0x79c3cf0553b6852890e8ba58878a5bca8b06d90c',

  // Augur Market Factories
  '0x03810440953e2bcd2f17a63706a4c8325e0abf94', // MLB
  '0xe696b8fa35e487c3a02c2444777c7a2ef6cd0297', // NBA
  '0x1f3ef7ca2b2ca07a397e7bc1beb8c3cffc57e95a', // NFL
  '0x6d2e53d53aec521dec3d53c533e6c6e60444c655', // MMA
  '0x48725bac1c27c2daf5ed7df22d6a9d781053fec1', // Crypto

  // USDC on Polygon (for token approvals)
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
]);

/**
 * Check if an address is in the whitelist.
 *
 * @param address - The address to check (will be lowercased)
 * @returns true if the address is whitelisted, false otherwise
 *
 * @example
 * ```typescript
 * if (!isWhitelisted(transaction.to)) {
 *   throw new SecurityError('Destination address not whitelisted');
 * }
 * ```
 */
export function isWhitelisted(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  const normalized = address.toLowerCase().trim();

  // Must be a valid Ethereum address format
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    return false;
  }

  return AUGUR_WHITELIST.includes(normalized);
}

/**
 * Assert that an address is whitelisted.
 * Throws if not whitelisted.
 *
 * @param address - The address to check
 * @param context - Optional context for error message
 * @throws SecurityError if address is not whitelisted
 */
export function assertWhitelisted(address: string, context?: string): void {
  if (!isWhitelisted(address)) {
    const ctx = context ? ` (${context})` : '';
    throw new WhitelistError(
      `Address ${address} is not whitelisted${ctx}. ` +
        'Thufir can only interact with Augur Turbo contracts.'
    );
  }
}

/**
 * Error thrown when an address is not whitelisted.
 */
export class WhitelistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhitelistError';
  }
}

/**
 * Get all whitelisted addresses (for display purposes only).
 *
 * @returns A copy of the whitelist array
 */
export function getWhitelistedAddresses(): readonly string[] {
  return [...AUGUR_WHITELIST];
}

/**
 * Get human-readable descriptions of whitelisted addresses.
 */
export function getWhitelistDescriptions(): Array<{
  address: string;
  description: string;
}> {
  return [
    {
      address: '0x79c3cf0553b6852890e8ba58878a5bca8b06d90c',
      description: 'Augur Turbo AMM Factory',
    },
    {
      address: '0x03810440953e2bcd2f17a63706a4c8325e0abf94',
      description: 'Augur MLB Market Factory',
    },
    {
      address: '0xe696b8fa35e487c3a02c2444777c7a2ef6cd0297',
      description: 'Augur NBA Market Factory',
    },
    {
      address: '0x1f3ef7ca2b2ca07a397e7bc1beb8c3cffc57e95a',
      description: 'Augur NFL Market Factory',
    },
    {
      address: '0x6d2e53d53aec521dec3d53c533e6c6e60444c655',
      description: 'Augur MMA Market Factory',
    },
    {
      address: '0x48725bac1c27c2daf5ed7df22d6a9d781053fec1',
      description: 'Augur Crypto Market Factory',
    },
    {
      address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
      description: 'USDC on Polygon',
    },
  ];
}
