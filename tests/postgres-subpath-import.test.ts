/**
 * Resolves `ratelimit-flex/postgres` via Vitest alias to `src/stores/postgres/index.ts`
 * (same as package.json `exports["./postgres"]` after build). Presets are exported from the package root (`ratelimit-flex`), not this subpath.
 */
import { describe, expect, it } from 'vitest';
import { PgStore as PgStoreRoot, postgresPreset } from '../src/index.js';
import { PgStore, pgStoreSchema } from 'ratelimit-flex/postgres';
import type { PgClientLike, PgStoreOptions } from 'ratelimit-flex/postgres';

describe('ratelimit-flex/postgres subpath', () => {
  it('exports PgStore, DDL, and public types', () => {
    expect(PgStore).toBeDefined();
    expect(typeof pgStoreSchema).toBe('string');
    expect(pgStoreSchema).toContain('CREATE TABLE');

    const opts = {} as PgStoreOptions;
    const client = { query: async () => ({ rows: [] }) } satisfies Pick<PgClientLike, 'query'>;
    expect(opts).toBeDefined();
    expect(client.query).toBeDefined();
  });

  it('postgresPreset (root export) is usable with a minimal PgClientLike', () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    const partial = postgresPreset({ pool });
    expect(partial.store).toBeInstanceOf(PgStoreRoot);
  });
});
