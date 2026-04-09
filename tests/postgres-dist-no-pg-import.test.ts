/**
 * Ensures built artifacts never add a static dependency on the `pg` package
 * (optional peer). Run after `npm run build`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readDist(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

/** Strip block comments so JSDoc examples do not false-positive (e.g. documented `pg` usage). */
function stripBlockComments(js: string): string {
  return js.replace(/\/\*[\s\S]*?\*\//g, '');
}

const pgImportRe = /(?:from|import)\s*\(?\s*["']pg["']\s*\)?/;

const hasDist = existsSync(join(root, 'dist/index.js'));

describe('dist: no static pg imports in published modules', () => {
  it.skipIf(!hasDist)('main entry and core paths avoid importing pg', () => {
    const paths = [
      'dist/index.js',
      'dist/stores/postgres/PgStore.js',
      'dist/stores/postgres/index.js',
      'dist/presets/postgres-presets.js',
      'dist/middleware/express.js',
    ];
    for (const p of paths) {
      if (!existsSync(join(root, p))) {
        continue;
      }
      const src = stripBlockComments(readDist(p));
      expect(src, p).not.toMatch(pgImportRe);
    }
  });
});
