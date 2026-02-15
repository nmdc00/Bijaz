import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function copyAsset(srcRel, dstRel) {
  const src = join(process.cwd(), srcRel);
  const dst = join(process.cwd(), dstRel);
  if (!existsSync(src)) {
    throw new Error(`Missing asset: ${srcRel}`);
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  // eslint-disable-next-line no-console
  console.log(`copied ${srcRel} -> ${dstRel}`);
}

// Non-TS runtime assets required by compiled code.
copyAsset('src/memory/schema.sql', 'dist/memory/schema.sql');

