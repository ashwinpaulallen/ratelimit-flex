/**
 * Forward migration: create the shared rate-limits table and index.
 * Run this yourself — the library does not execute DDL at runtime.
 */
export const pgStoreSchema = `
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  total_hits BIGINT NOT NULL DEFAULT 0,
  reset_at TIMESTAMPTZ NOT NULL,
  -- Sliding window: JSONB array of hit timestamps (epoch ms as BIGINT).
  -- NULL for fixed window and token bucket.
  hits JSONB,
  -- Token bucket: current token count and last refill time.
  -- NULL for window strategies.
  tokens DOUBLE PRECISION,
  last_refill_at TIMESTAMPTZ
);

-- Index for background cleanup of expired rows.
CREATE INDEX IF NOT EXISTS rate_limits_reset_at_idx
  ON rate_limits (reset_at);
`;

/**
 * Reverse migration: drop index and table created by {@link pgStoreSchema}.
 */
export const pgStoreSchemaDown = `
DROP INDEX IF EXISTS rate_limits_reset_at_idx;
DROP TABLE IF EXISTS rate_limits;
`;
