import { describe, expect, it } from 'vitest';

import { filterIntelAlerts, rankIntelAlerts } from '../../src/intel/alerts.js';

describe('filterIntelAlerts', () => {
  it('filters by keywords and sources', () => {
    const items = [
      { title: 'Fed raises rates', source: 'NewsAPI' },
      { title: 'Sports result', source: 'ESPN' },
    ];
    const alerts = filterIntelAlerts(
      items,
      {
        includeKeywords: ['fed'],
        includeSources: ['NewsAPI'],
        watchlistOnly: false,
      },
      []
    );
    expect(alerts.length).toBe(1);
  });

  it('filters by watchlist overlap', () => {
    const items = [{ title: 'Tesla deliveries beat estimates', source: 'NewsAPI' }];
    const alerts = filterIntelAlerts(
      items,
      { watchlistOnly: true, minKeywordOverlap: 1 },
      ['Tesla Q1 deliveries']
    );
    expect(alerts.length).toBe(1);
  });

  it('filters by sentiment and entities', () => {
    const items = [
      { title: 'Apple stock plunges after miss', source: 'NewsAPI' },
      { title: 'Microsoft beats earnings', source: 'NewsAPI' },
    ];
    const alerts = filterIntelAlerts(
      items,
      { minSentiment: 0, includeEntities: ['Microsoft'], watchlistOnly: false },
      []
    );
    expect(alerts.length).toBe(1);
  });

  it('ranks alerts by score', () => {
    const items = [
      { title: 'Tesla beats estimates', source: 'NewsAPI' },
      { title: 'Fed signals hike', source: 'NewsAPI' },
    ];
    const ranked = rankIntelAlerts(
      items,
      { includeKeywords: ['tesla'], keywordWeight: 2, watchlistOnly: false },
      []
    );
    expect(ranked[0]?.text).toContain('Tesla');
  });

  it('extracts multi-word entities for matching', () => {
    const items = [
      { title: 'Federal Reserve Chair Jerome Powell speaks', source: 'NewsAPI' },
    ];
    const alerts = filterIntelAlerts(
      items,
      { includeEntities: ['Federal Reserve', 'Jerome Powell'], watchlistOnly: false },
      []
    );
    expect(alerts.length).toBe(1);
  });

  it('respects sentiment presets', () => {
    const items = [
      { title: 'Market plunges on bad news', source: 'NewsAPI' },
      { title: 'Stocks surge on strong results', source: 'NewsAPI' },
    ];
    const negative = filterIntelAlerts(
      items,
      { sentimentPreset: 'negative', watchlistOnly: false },
      []
    );
    const positive = filterIntelAlerts(
      items,
      { sentimentPreset: 'positive', watchlistOnly: false },
      []
    );
    expect(negative.length).toBe(1);
    expect(positive.length).toBe(1);
  });

  it('applies entity aliases and explains reasons', () => {
    const items = [
      { title: 'Fed signals pause', source: 'NewsAPI' },
    ];
    const ranked = rankIntelAlerts(
      items,
      {
        includeEntities: ['Federal Reserve'],
        entityAliases: { 'Federal Reserve': ['Fed'] },
        showReasons: true,
        watchlistOnly: false,
      },
      []
    );
    expect(ranked[0]?.text).toContain('match=');
  });
});
