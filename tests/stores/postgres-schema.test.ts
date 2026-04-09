import { describe, expect, it } from 'vitest';
import { pgStoreSchema, pgStoreSchemaDown } from '../../src/stores/postgres/schema.js';

describe('pgStore schema SQL', () => {
  it('up migration is non-empty and contains expected DDL fragments', () => {
    expect(pgStoreSchema.trim().length).toBeGreaterThan(0);
    expect(pgStoreSchema).toContain('CREATE TABLE IF NOT EXISTS rate_limits');
    expect(pgStoreSchema).toContain('total_hits BIGINT');
    expect(pgStoreSchema).toContain('reset_at TIMESTAMPTZ');
    expect(pgStoreSchema).toContain('hits JSONB');
    expect(pgStoreSchema).toContain('tokens DOUBLE PRECISION');
    expect(pgStoreSchema).toContain('last_refill_at TIMESTAMPTZ');
    expect(pgStoreSchema).toContain('CREATE INDEX IF NOT EXISTS rate_limits_reset_at_idx');
    expect(pgStoreSchema).toContain('ON rate_limits (reset_at)');
  });

  it('down migration is non-empty and drops created objects', () => {
    expect(pgStoreSchemaDown.trim().length).toBeGreaterThan(0);
    expect(pgStoreSchemaDown).toContain('DROP INDEX IF EXISTS rate_limits_reset_at_idx');
    expect(pgStoreSchemaDown).toContain('DROP TABLE IF EXISTS rate_limits');
  });
});
