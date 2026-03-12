import { describe, expect, it, vi, beforeEach } from 'vitest';

describe('extractEventsFromIntel', () => {
  beforeEach(() => vi.resetModules());

  it('extracts a material energy event from oil disruption intel', async () => {
    const upsertEvent = vi.fn((input) => ({
      id: 'evt-1',
      eventKey: 'key-1',
      title: input.title,
      domain: input.domain,
      occurredAt: input.occurredAt,
      sourceIntelIds: input.sourceIntelIds ?? [],
      tags: input.tags ?? [],
      status: 'active',
      createdAt: '2026-03-12 00:00:00',
      updatedAt: '2026-03-12 00:00:00',
    }));
    vi.doMock('../../src/memory/events.js', () => ({ upsertEvent }));

    const { extractEventsFromIntel } = await import('../../src/events/extract.js');
    const result = extractEventsFromIntel([
      {
        id: 'intel-1',
        title: 'Iran threat raises Strait of Hormuz disruption risk',
        content: 'Tanker traffic disruption could tighten crude supply and push oil higher.',
        source: 'web_search:reuters',
        sourceType: 'news',
        timestamp: '2026-03-12T12:00:00Z',
      },
    ]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.event.domain).toBe('energy');
    expect(result.events[0]?.event.tags).toContain('shipping_disruption');
    expect(result.gaps).toHaveLength(0);
  });

  it('reports a gap for non-material intel', async () => {
    vi.doMock('../../src/memory/events.js', () => ({ upsertEvent: vi.fn() }));
    const { extractEventsFromIntel } = await import('../../src/events/extract.js');
    const result = extractEventsFromIntel([
      {
        id: 'intel-1',
        title: 'Market participants discuss oil',
        content: 'Commentary remains mixed.',
        source: 'web_search:test',
        sourceType: 'news',
        timestamp: '2026-03-12T12:00:00Z',
      },
    ]);

    expect(result.events).toHaveLength(0);
    expect(result.gaps[0]?.reason).toBe('insufficient_signal');
  });
});
