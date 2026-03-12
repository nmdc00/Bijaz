import { describe, expect, it } from 'vitest';

import {
  loadHistoricalEventCases,
  searchHistoricalCases,
  validateHistoricalCase,
} from '../../src/events/casebase.js';

describe('validateHistoricalCase', () => {
  it('rejects malformed seed cases', () => {
    const result = validateHistoricalCase({
      case_key: '',
      event_date: '2020-01-01',
      title: 'Bad case',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('loadHistoricalEventCases', () => {
  it('loads the seeded corpus successfully', () => {
    const cases = loadHistoricalEventCases();

    expect(cases.length).toBeGreaterThanOrEqual(60);
    expect(cases.some((entry) => entry.case_key === '2019-abqaiq-attack-oil')).toBe(true);
    expect(cases.every((entry) => validateHistoricalCase(entry).valid)).toBe(true);
  });
});

describe('searchHistoricalCases', () => {
  it('retrieves energy infrastructure cases by domain and mechanism tags', () => {
    const results = searchHistoricalCases({
      domain: 'energy',
      tags: ['supply_shock', 'infrastructure'],
      mechanismQuery: 'supply',
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.domain).toBe('energy');
    expect(results.some((entry) => entry.case_key === '2019-abqaiq-attack-oil')).toBe(true);
  });
});
