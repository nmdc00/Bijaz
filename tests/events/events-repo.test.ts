import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// buildEventKey stability
// ---------------------------------------------------------------------------

describe('buildEventKey', () => {
  it('produces the same key for the same title/date/domain regardless of time variation', async () => {
    const { buildEventKey } = await import('../../src/memory/events.js');

    const k1 = buildEventKey('Russia bans wheat exports', '2010-08-05T00:00:00Z', 'agri');
    const k2 = buildEventKey('Russia bans wheat exports', '2010-08-05T14:32:00Z', 'agri');
    // Both normalize to the same date-only prefix
    expect(k1).toBe(k2);
  });

  it('produces different keys for different titles', async () => {
    const { buildEventKey } = await import('../../src/memory/events.js');

    const k1 = buildEventKey('Russia bans wheat exports', '2010-08-05', 'agri');
    const k2 = buildEventKey('US drought hits corn belt', '2010-08-05', 'agri');
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different domains', async () => {
    const { buildEventKey } = await import('../../src/memory/events.js');

    const k1 = buildEventKey('Major supply shock', '2022-02-24', 'agri');
    const k2 = buildEventKey('Major supply shock', '2022-02-24', 'energy');
    expect(k1).not.toBe(k2);
  });

  it('returns a 32-character hex string', async () => {
    const { buildEventKey } = await import('../../src/memory/events.js');

    const key = buildEventKey('Test event', '2024-01-01', 'macro');
    expect(key).toHaveLength(32);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it('is case-insensitive for title', async () => {
    const { buildEventKey } = await import('../../src/memory/events.js');

    const k1 = buildEventKey('RUSSIA BANS WHEAT EXPORTS', '2010-08-05', 'agri');
    const k2 = buildEventKey('russia bans wheat exports', '2010-08-05', 'agri');
    expect(k1).toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// events CRUD (mocked DB)
// ---------------------------------------------------------------------------

describe('upsertEvent', () => {
  beforeEach(() => vi.resetModules());

  it('inserts a new event and returns it', async () => {
    const rows: Record<string, unknown>[] = [];

    const fakeDb = {
      prepare: (sql: string) => ({
        get: (...args: unknown[]) => {
          if (sql.includes('WHERE event_key =')) {
            return rows.find((r) => r.event_key === args[0]);
          }
          if (sql.includes('WHERE id =')) {
            return rows.find((r) => r.id === args[0]);
          }
          return undefined;
        },
        run: (...args: unknown[]) => {
          if (sql.includes('INSERT INTO events')) {
            rows.push({
              id: args[0],
              event_key: args[1],
              title: args[2],
              domain: args[3],
              occurred_at: args[4],
              source_intel_ids: args[5],
              tags: args[6],
              status: args[7],
              created_at: args[8],
              updated_at: args[9],
            });
          }
        },
        all: () => rows,
      }),
    };

    vi.doMock('../../src/memory/db.js', () => ({ openDatabase: () => fakeDb }));

    const { upsertEvent } = await import('../../src/memory/events.js');

    const event = upsertEvent({
      title: 'Russia bans wheat exports',
      domain: 'agri',
      occurredAt: '2010-08-05T00:00:00Z',
      sourceIntelIds: ['intel-1'],
      tags: ['export_ban', 'supply_shock'],
    });

    expect(event.title).toBe('Russia bans wheat exports');
    expect(event.domain).toBe('agri');
    expect(event.sourceIntelIds).toContain('intel-1');
    expect(event.tags).toContain('export_ban');
    expect(event.eventKey).toHaveLength(32);
    expect(event.status).toBe('active');
  });

  it('merges source intel IDs on duplicate upsert', async () => {
    const rows: Record<string, unknown>[] = [];
    let updateCalled = false;

    const fakeDb = {
      prepare: (sql: string) => {
        // UPDATE must be checked before WHERE clause to avoid mis-routing
        if (sql.trim().startsWith('UPDATE events')) {
          return {
            run: (...args: unknown[]) => {
              updateCalled = true;
              const key = args[4]; // event_key is 5th param (COALESCE, tags, status, now, key)
              const row = rows.find((r) => r.event_key === key);
              if (row) {
                row.source_intel_ids = args[0] as string;
              }
            },
            get: () => undefined,
          };
        }
        if (sql.includes('INSERT INTO events')) {
          return {
            run: (...args: unknown[]) => {
              rows.push({
                id: args[0],
                event_key: args[1],
                title: args[2],
                domain: args[3],
                occurred_at: args[4],
                source_intel_ids: args[5],
                tags: args[6],
                status: args[7],
                created_at: args[8],
                updated_at: args[9],
              });
            },
            get: () => undefined,
          };
        }
        if (sql.includes('WHERE event_key =')) {
          return {
            get: (key: unknown) => rows.find((r) => r.event_key === key),
            run: () => {},
          };
        }
        if (sql.includes('WHERE id =')) {
          return { get: (id: unknown) => rows.find((r) => r.id === id) };
        }
        return { get: () => undefined, run: () => {}, all: () => [] };
      },
    };

    vi.doMock('../../src/memory/db.js', () => ({ openDatabase: () => fakeDb }));

    const { upsertEvent } = await import('../../src/memory/events.js');

    // First insert
    upsertEvent({
      title: 'Russia bans wheat',
      domain: 'agri',
      occurredAt: '2010-08-05T00:00:00Z',
      sourceIntelIds: ['intel-1'],
    });

    // Second upsert with different intel ID (same normalized key)
    upsertEvent({
      title: 'Russia bans wheat',
      domain: 'agri',
      occurredAt: '2010-08-05T12:00:00Z',
      sourceIntelIds: ['intel-2'],
    });

    expect(updateCalled).toBe(true);
    const mergedIds = JSON.parse(rows[0].source_intel_ids as string) as string[];
    expect(mergedIds).toContain('intel-1');
    expect(mergedIds).toContain('intel-2');
  });
});

// ---------------------------------------------------------------------------
// thoughts CRUD (mocked DB)
// ---------------------------------------------------------------------------

describe('insertThought', () => {
  beforeEach(() => vi.resetModules());

  it('inserts a thought and assigns version 1 for first thought', async () => {
    const thoughtRows: Record<string, unknown>[] = [];

    const fakeDb = {
      prepare: (sql: string) => {
        if (sql.includes('MAX(version)')) {
          return { get: () => ({ v: null }) };
        }
        if (sql.includes('INSERT INTO event_thoughts')) {
          return {
            run: (...args: unknown[]) => {
              thoughtRows.push({
                id: args[0],
                event_id: args[1],
                version: args[2],
                mechanism: args[3],
                causal_chain: args[4],
                impacted_assets: args[5],
                invalidation_conditions: args[6],
                model_version: args[7],
                created_at: args[8],
              });
            },
          };
        }
        if (sql.includes('WHERE id =')) {
          return { get: (id: unknown) => thoughtRows.find((r) => r.id === id) };
        }
        return { get: () => undefined, run: () => {}, all: () => [] };
      },
    };

    vi.doMock('../../src/memory/db.js', () => ({ openDatabase: () => fakeDb }));

    const { insertThought } = await import('../../src/memory/events.js');

    const thought = insertThought({
      eventId: 'evt-123',
      mechanism: 'Export ban → price spike',
      causalChain: ['Ban announced', 'Supply drops', 'Futures spike'],
      impactedAssets: [{ symbol: 'WHEAT', direction: 'up', confidence: 0.85 }],
      invalidationConditions: ['Russia reverses ban'],
    });

    expect(thought.version).toBe(1);
    expect(thought.eventId).toBe('evt-123');
    expect(thought.mechanism).toBe('Export ban → price spike');
    expect(thought.causalChain).toHaveLength(3);
    expect(thought.impactedAssets[0].symbol).toBe('WHEAT');
  });

  it('auto-increments version for subsequent thoughts', async () => {
    const thoughtRows: Record<string, unknown>[] = [];

    const fakeDb = {
      prepare: (sql: string) => {
        if (sql.includes('MAX(version)')) {
          return { get: () => ({ v: 2 }) };
        }
        if (sql.includes('INSERT INTO event_thoughts')) {
          return {
            run: (...args: unknown[]) => {
              thoughtRows.push({ id: args[0], version: args[2] });
            },
          };
        }
        if (sql.includes('WHERE id =')) {
          return {
            get: (id: unknown) =>
              thoughtRows.find((r) => r.id === id) ?? {
                id,
                event_id: 'evt-1',
                version: 3,
                mechanism: 'm',
                causal_chain: '[]',
                impacted_assets: '[]',
                invalidation_conditions: '[]',
                model_version: null,
                created_at: '2024-01-01',
              },
          };
        }
        return { get: () => undefined, run: () => {}, all: () => [] };
      },
    };

    vi.doMock('../../src/memory/db.js', () => ({ openDatabase: () => fakeDb }));

    const { insertThought } = await import('../../src/memory/events.js');

    const thought = insertThought({
      eventId: 'evt-1',
      mechanism: 'Updated reasoning',
      causalChain: ['Step A'],
      impactedAssets: [{ symbol: 'BTC', direction: 'down', confidence: 0.6 }],
      invalidationConditions: [],
    });

    expect(thought.version).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// forecasts CRUD (mocked DB)
// ---------------------------------------------------------------------------

describe('insertForecast', () => {
  beforeEach(() => vi.resetModules());

  it('inserts a forecast with status=open and sets expiresAt', async () => {
    const forecastRows: Record<string, unknown>[] = [];

    const fakeDb = {
      prepare: (sql: string) => {
        if (sql.includes('INSERT INTO event_forecasts')) {
          return {
            run: (...args: unknown[]) => {
              forecastRows.push({
                id: args[0],
                event_id: args[1],
                thought_id: args[2],
                asset: args[3],
                domain: args[4],
                direction: args[5],
                horizon_hours: args[6],
                confidence: args[7],
                invalidation_conditions: args[8],
                status: 'open',
                expires_at: args[9],
                resolved_at: null,
                created_at: args[10],
              });
            },
          };
        }
        if (sql.includes('WHERE id =')) {
          return { get: (id: unknown) => forecastRows.find((r) => r.id === id) };
        }
        return { get: () => undefined, run: () => {}, all: () => [] };
      },
    };

    vi.doMock('../../src/memory/db.js', () => ({ openDatabase: () => fakeDb }));

    const { insertForecast } = await import('../../src/memory/events.js');

    const forecast = insertForecast({
      eventId: 'evt-123',
      thoughtId: 'thgt-456',
      asset: 'WHEAT',
      domain: 'agri',
      direction: 'up',
      horizonHours: 72,
      confidence: 0.8,
    });

    expect(forecast.status).toBe('open');
    expect(forecast.asset).toBe('WHEAT');
    expect(forecast.direction).toBe('up');
    expect(forecast.horizonHours).toBe(72);
    expect(forecast.confidence).toBe(0.8);
    expect(forecast.expiresAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// updateForecastStatus (mocked DB)
// ---------------------------------------------------------------------------

describe('updateForecastStatus', () => {
  beforeEach(() => vi.resetModules());

  it('updates status and sets resolvedAt for non-open transitions', async () => {
    let updatedStatus: unknown;
    let updatedResolvedAt: unknown;

    const fakeDb = {
      prepare: (sql: string) => {
        if (sql.includes('UPDATE event_forecasts')) {
          return {
            run: (...args: unknown[]) => {
              updatedStatus = args[0];
              updatedResolvedAt = args[1];
            },
          };
        }
        return { get: () => undefined, run: () => {}, all: () => [] };
      },
    };

    vi.doMock('../../src/memory/db.js', () => ({ openDatabase: () => fakeDb }));

    const { updateForecastStatus } = await import('../../src/memory/events.js');

    updateForecastStatus('fc-001', 'confirmed');

    expect(updatedStatus).toBe('confirmed');
    expect(updatedResolvedAt).not.toBeNull();
  });

  it('sets resolvedAt to null when transitioning back to open', async () => {
    let updatedResolvedAt: unknown = 'some-date';

    const fakeDb = {
      prepare: (sql: string) => {
        if (sql.includes('UPDATE event_forecasts')) {
          return {
            run: (...args: unknown[]) => {
              updatedResolvedAt = args[1];
            },
          };
        }
        return { get: () => undefined, run: () => {}, all: () => [] };
      },
    };

    vi.doMock('../../src/memory/db.js', () => ({ openDatabase: () => fakeDb }));

    const { updateForecastStatus } = await import('../../src/memory/events.js');

    updateForecastStatus('fc-001', 'open');

    expect(updatedResolvedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// insertOutcome (mocked DB)
// ---------------------------------------------------------------------------

describe('insertOutcome', () => {
  beforeEach(() => vi.resetModules());

  it('inserts an outcome and marks the forecast resolved', async () => {
    const outcomeRows: Record<string, unknown>[] = [];
    let forecastStatusUpdate: string | null = null;

    const fakeDb = {
      prepare: (sql: string) => {
        if (sql.includes('INSERT INTO event_outcomes')) {
          return {
            run: (...args: unknown[]) => {
              outcomeRows.push({
                id: args[0],
                forecast_id: args[1],
                event_id: args[2],
                resolution_status: args[3],
                resolution_note: args[4],
                actual_direction: args[5],
                resolution_price: args[6],
                resolved_at: args[7],
                created_at: args[8],
              });
            },
          };
        }
        if (sql.includes('UPDATE event_forecasts')) {
          return {
            run: (...args: unknown[]) => {
              forecastStatusUpdate = args[0] as string;
            },
          };
        }
        if (sql.includes('WHERE id =')) {
          return { get: (id: unknown) => outcomeRows.find((r) => r.id === id) };
        }
        return { get: () => undefined, run: () => {}, all: () => [] };
      },
    };

    vi.doMock('../../src/memory/db.js', () => ({ openDatabase: () => fakeDb }));

    const { insertOutcome } = await import('../../src/memory/events.js');

    const outcome = insertOutcome({
      forecastId: 'fc-789',
      eventId: 'evt-123',
      resolutionStatus: 'confirmed',
      actualDirection: 'up',
      resolutionNote: 'Wheat futures rose 25% in 72h window',
    });

    expect(outcome.resolutionStatus).toBe('confirmed');
    expect(outcome.actualDirection).toBe('up');
    expect(outcome.resolutionNote).toBe('Wheat futures rose 25% in 72h window');
    expect(forecastStatusUpdate).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
// DB schema: verify schema.sql contains all 4 new event tables
// ---------------------------------------------------------------------------

describe('schema.sql causal event tables', () => {
  it('schema file declares all 4 event tables', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(here, '../../src/memory/schema.sql');
    const sql = readFileSync(schemaPath, 'utf-8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS events');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS event_thoughts');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS event_forecasts');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS event_outcomes');
  });

  it('schema includes required columns for events table', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(here, '../../src/memory/schema.sql');
    const sql = readFileSync(schemaPath, 'utf-8');

    // Verify event_key unique constraint exists
    expect(sql).toContain('event_key TEXT NOT NULL UNIQUE');
    // Verify foreign keys in child tables
    expect(sql).toContain('REFERENCES events(id) ON DELETE CASCADE');
    // Verify forecast status CHECK
    expect(sql).toContain("CHECK(status IN ('open', 'confirmed', 'invalidated', 'expired'))");
  });
});
