import type { RateLimitStrategy } from '../../types/index.js';

/**
 * Minimal interface for a Postgres client. Compatible with `pg.Pool`,
 * `pg.Client`, `postgres.Sql`, `pg-promise` bases, and Drizzle raw execute.
 * Users pass whatever they already have.
 */
export interface PgClientLike {
  query(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;

  /**
   * Optional `pg.Pool`-style acquirer — use so token-bucket increments can run
   * `BEGIN`/`COMMIT` on one connection. Plain `pg.Client` can omit this and use
   * sequential {@link PgClientLike.query} on the same client.
   */
  connect?: () => Promise<{
    query(
      text: string,
      values?: ReadonlyArray<unknown>,
    ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
    release: () => void | Promise<void>;
  }>;
}

export interface PgStoreOptions {
  /** Connection — pg.Pool is recommended. */
  client: PgClientLike;

  /** Strategy. Default: SLIDING_WINDOW. */
  strategy?: RateLimitStrategy;

  /** Window length for sliding/fixed strategies, ms. */
  windowMs?: number;

  /** Max requests per window. */
  maxRequests?: number;

  /** Token bucket fields. */
  tokensPerInterval?: number;
  interval?: number;
  bucketSize?: number;

  /**
   * Unqualified table name only (default: `'rate_limits'`).
   *
   * @description Must match `[a-zA-Z_][a-zA-Z0-9_]*` — a single SQL identifier with **no** schema
   * prefix. Values like `public.rate_limits` are rejected; put the table in the connection’s
   * schema search path (e.g. default `public`) or adjust `search_path` instead of qualifying here.
   * The table is **not** created automatically — run the migration SQL
   * (`pgStoreSchema` / `pgStoreSchemaDown`).
   */
  tableName?: string;

  /**
   * Background sweep interval to delete expired rows, ms. Set to 0 to
   * disable the background sweep and rely on lazy cleanup in increment().
   * Default: 60_000 (60s).
   */
  autoSweepIntervalMs?: number;

  /** Key prefix so multiple limiters can share a table. Default: 'rlf:'. */
  keyPrefix?: string;

  /** Fail-open / fail-closed on Postgres errors. Default: 'fail-open'. */
  onPostgresError?: 'fail-open' | 'fail-closed';

  /** Custom logger. Default: console.warn. */
  onWarn?: (msg: string, err?: Error) => void;
}
