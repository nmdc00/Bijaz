import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(rootDir);

const sourcePath = join(projectRoot, 'src', 'memory', 'schema.sql');
const targetPath = join(projectRoot, 'dist', 'memory', 'schema.sql');

mkdirSync(dirname(targetPath), { recursive: true });
copyFileSync(sourcePath, targetPath);

const sourceSql = readFileSync(sourcePath, 'utf8');
const targetSql = readFileSync(targetPath, 'utf8');

if (sourceSql !== targetSql) {
  throw new Error(`Runtime schema asset copy failed: ${targetPath} does not match ${sourcePath}`);
}

console.log(`Copied runtime schema asset to ${targetPath}`);
