import { describe, expect, test } from 'vitest';

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { installConsoleFileMirror } from '../../src/core/unified-logging.js';

describe('unified logging', () => {
  test('mirrors console output into a single file', async () => {
    const filePath = join('/tmp', `thufir-unified-log-${Date.now()}-${Math.random()}.log`);
    rmSync(filePath, { force: true });

    const handle = installConsoleFileMirror({ filePath });
    try {
      console.log('hello', { a: 1 });
      console.error('boom');
      await new Promise((r) => setTimeout(r, 20));

      expect(existsSync(filePath)).toBe(true);
      const text = readFileSync(filePath, 'utf8');
      expect(text).toMatch(/INFO: hello/);
      expect(text).toMatch(/ERROR: boom/);
    } finally {
      handle.uninstall();
      rmSync(filePath, { force: true });
    }
  });
});

