import { describe, it, expect } from 'vitest';

import {
  validateEventInput,
  validateThoughtInput,
  validateForecastInput,
  validateOutcomeInput,
  validateForecastStatus,
} from '../../src/events/types.js';

// ---------------------------------------------------------------------------
// validateEventInput
// ---------------------------------------------------------------------------

describe('validateEventInput', () => {
  const valid = {
    title: 'Russia bans wheat exports',
    domain: 'agri',
    occurredAt: '2010-08-05T00:00:00Z',
  };

  it('accepts a fully valid input', () => {
    expect(validateEventInput(valid).valid).toBe(true);
  });

  it('rejects null input', () => {
    const result = validateEventInput(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects missing title', () => {
    const result = validateEventInput({ ...valid, title: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('title'))).toBe(true);
  });

  it('rejects invalid domain', () => {
    const result = validateEventInput({ ...valid, domain: 'weather' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('domain'))).toBe(true);
  });

  it('rejects missing occurredAt', () => {
    const result = validateEventInput({ ...valid, occurredAt: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('occurredAt'))).toBe(true);
  });

  it('accepts all valid domains', () => {
    const domains = ['crypto', 'energy', 'agri', 'macro', 'equity', 'rates', 'fx', 'metals', 'other'];
    for (const domain of domains) {
      expect(validateEventInput({ ...valid, domain }).valid).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// validateThoughtInput
// ---------------------------------------------------------------------------

describe('validateThoughtInput', () => {
  const valid = {
    eventId: 'evt-123',
    mechanism: 'Export ban → reduced global supply → price spike',
    causalChain: ['Russia announces ban', 'Global supply drops 15%', 'Wheat futures spike'],
    impactedAssets: [{ symbol: 'WHEAT', direction: 'up', confidence: 0.9 }],
    invalidationConditions: ['Russia reverses ban within 30 days'],
  };

  it('accepts valid thought input', () => {
    expect(validateThoughtInput(valid).valid).toBe(true);
  });

  it('rejects empty eventId', () => {
    const result = validateThoughtInput({ ...valid, eventId: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('eventId'))).toBe(true);
  });

  it('rejects empty mechanism', () => {
    const result = validateThoughtInput({ ...valid, mechanism: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('mechanism'))).toBe(true);
  });

  it('rejects empty causalChain', () => {
    const result = validateThoughtInput({ ...valid, causalChain: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('causalChain'))).toBe(true);
  });

  it('rejects empty impactedAssets', () => {
    const result = validateThoughtInput({ ...valid, impactedAssets: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('impactedAssets'))).toBe(true);
  });

  it('rejects impactedAsset with invalid direction', () => {
    const result = validateThoughtInput({
      ...valid,
      impactedAssets: [{ symbol: 'WHEAT', direction: 'sideways', confidence: 0.9 }],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects impactedAsset with confidence out of range', () => {
    const result = validateThoughtInput({
      ...valid,
      impactedAssets: [{ symbol: 'WHEAT', direction: 'up', confidence: 1.5 }],
    });
    expect(result.valid).toBe(false);
  });

  it('accepts impactedAsset with confidence exactly 0 or 1', () => {
    expect(
      validateThoughtInput({
        ...valid,
        impactedAssets: [{ symbol: 'WHEAT', direction: 'up', confidence: 0 }],
      }).valid
    ).toBe(true);
    expect(
      validateThoughtInput({
        ...valid,
        impactedAssets: [{ symbol: 'WHEAT', direction: 'up', confidence: 1 }],
      }).valid
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateForecastInput
// ---------------------------------------------------------------------------

describe('validateForecastInput', () => {
  const valid = {
    eventId: 'evt-123',
    thoughtId: 'thgt-456',
    asset: 'WHEAT',
    domain: 'agri',
    direction: 'up',
    horizonHours: 72,
    confidence: 0.8,
  };

  it('accepts valid forecast input', () => {
    expect(validateForecastInput(valid).valid).toBe(true);
  });

  it('rejects zero horizonHours', () => {
    const result = validateForecastInput({ ...valid, horizonHours: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('horizonHours'))).toBe(true);
  });

  it('rejects invalid direction', () => {
    const result = validateForecastInput({ ...valid, direction: 'sideways' });
    expect(result.valid).toBe(false);
  });

  it('rejects confidence above 1', () => {
    const result = validateForecastInput({ ...valid, confidence: 1.1 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
  });

  it('rejects empty asset', () => {
    const result = validateForecastInput({ ...valid, asset: '' });
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateForecastStatus
// ---------------------------------------------------------------------------

describe('validateForecastStatus', () => {
  it('accepts valid statuses', () => {
    expect(validateForecastStatus('open')).toBe(true);
    expect(validateForecastStatus('confirmed')).toBe(true);
    expect(validateForecastStatus('invalidated')).toBe(true);
    expect(validateForecastStatus('expired')).toBe(true);
  });

  it('rejects invalid status', () => {
    expect(validateForecastStatus('pending')).toBe(false);
    expect(validateForecastStatus(null)).toBe(false);
    expect(validateForecastStatus(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateOutcomeInput
// ---------------------------------------------------------------------------

describe('validateOutcomeInput', () => {
  const valid = {
    forecastId: 'fc-789',
    eventId: 'evt-123',
    resolutionStatus: 'confirmed',
    actualDirection: 'up',
  };

  it('accepts valid outcome input', () => {
    expect(validateOutcomeInput(valid).valid).toBe(true);
  });

  it('rejects invalid resolutionStatus', () => {
    const result = validateOutcomeInput({ ...valid, resolutionStatus: 'pending' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('resolutionStatus'))).toBe(true);
  });

  it('rejects invalid actualDirection', () => {
    const result = validateOutcomeInput({ ...valid, actualDirection: 'sideways' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('actualDirection'))).toBe(true);
  });

  it('accepts all valid resolution statuses', () => {
    for (const s of ['confirmed', 'invalidated', 'expired', 'error']) {
      expect(validateOutcomeInput({ ...valid, resolutionStatus: s }).valid).toBe(true);
    }
  });

  it('accepts all valid actual directions', () => {
    for (const d of ['up', 'down', 'neutral', 'unknown']) {
      expect(validateOutcomeInput({ ...valid, actualDirection: d }).valid).toBe(true);
    }
  });
});
