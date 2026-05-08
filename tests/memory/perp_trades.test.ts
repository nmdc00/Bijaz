import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const previousDbPath = process.env.THUFIR_DB_PATH;

function createTempDbPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return join(dir, 'thufir.sqlite');
}

describe('perp_trades schema', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.THUFIR_DB_PATH = createTempDbPath('thufir-perp-trades-');
  });

  afterEach(() => {
    vi.resetModules();
    const dbPath = process.env.THUFIR_DB_PATH;
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(dirname(dbPath), { recursive: true, force: true });
    }
    if (previousDbPath === undefined) {
      delete process.env.THUFIR_DB_PATH;
    } else {
      process.env.THUFIR_DB_PATH = previousDbPath;
    }
  });

  it('creates secondary indices for symbol, status, and created_at', async () => {
    const { openDatabase } = await import('../../src/memory/db.js');
    const db = openDatabase();

    const indices = db.prepare("PRAGMA index_list('perp_trades')").all() as Array<{ name: string }>;
    const names = new Set(indices.map((index) => index.name));

    expect(names.has('idx_perp_trades_symbol')).toBe(true);
    expect(names.has('idx_perp_trades_status')).toBe(true);
    expect(names.has('idx_perp_trades_created')).toBe(true);
  });
});
