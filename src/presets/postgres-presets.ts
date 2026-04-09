import type { PgClientLike, PgStoreOptions } from '../stores/postgres/types.js';
import { PgStore } from '../stores/postgres/PgStore.js';
import { MemoryStore } from '../stores/memory-store.js';
import type {
  RateLimitOptions,
  TokenBucketRateLimitOptions,
  WindowRateLimitOptions,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { sanitizeRateLimitCap, sanitizeWindowMs } from '../utils/clamp.js';
import { ceilDiv, estimateWorkersFromEnvironment } from './estimate-workers.js';

/**
 * Options for {@link postgresPreset} / {@link failClosedPostgresPreset}: a Postgres-capable client (e.g. `pg.Pool`).
 *
 * @description The property is named **`pool`** because most callers pass `pg.Pool`; it is typed as {@link PgClientLike}.
 */
export type PostgresPresetPgOptions = { pool: PgClientLike };

/**
 * Map merged preset options to {@link PgStoreOptions} so window and token-bucket fields from `overrides` are not dropped.
 */
function buildPresetPgStoreOptions(
  client: PgClientLike,
  merged: Partial<RateLimitOptions>,
  extras?: Pick<PgStoreOptions, 'onPostgresError'>,
): PgStoreOptions {
  const strategy = merged.strategy ?? RateLimitStrategy.SLIDING_WINDOW;

  if (strategy === RateLimitStrategy.TOKEN_BUCKET) {
    const tb = merged as Partial<TokenBucketRateLimitOptions>;
    const win = merged as Partial<WindowRateLimitOptions>;
    return {
      client,
      ...extras,
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: Math.max(1, Math.floor(tb.tokensPerInterval ?? 10)),
      interval: sanitizeWindowMs(tb.interval, 60_000),
      bucketSize: sanitizeRateLimitCap(tb.bucketSize, 100),
      windowMs: sanitizeWindowMs(win.windowMs, 60_000),
      maxRequests: sanitizeRateLimitCap(
        typeof win.maxRequests === 'number' ? win.maxRequests : undefined,
        100,
      ),
    };
  }

  const w = merged as Partial<WindowRateLimitOptions>;
  return {
    client,
    ...extras,
    strategy: w.strategy ?? RateLimitStrategy.SLIDING_WINDOW,
    windowMs: sanitizeWindowMs(w.windowMs, 60_000),
    maxRequests: sanitizeRateLimitCap(
      typeof w.maxRequests === 'number' ? w.maxRequests : undefined,
      100,
    ),
  };
}

/**
 * Distributed preset: {@link PgStore}, sliding window, **100 req / minute**, draft-6 headers, in-memory shield on by default.
 *
 * @param pgOptions - `{ pool }` — your `pg.Pool` (or any {@link PgClientLike}).
 * @param options - Merged after defaults; may replace `store`, limits, headers, etc. For {@link RateLimitStrategy.TOKEN_BUCKET}, pass **`tokensPerInterval`**, **`interval`**, and **`bucketSize`** so {@link PgStore} matches.
 * @returns Partial {@link RateLimitOptions} with a {@link PgStore}.
 * @example
 * ```ts
 * import { expressRateLimiter, postgresPreset } from 'ratelimit-flex';
 * // Optional peer `pg`: construct a Pool (see pg docs), then:
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
 * app.use(expressRateLimiter(postgresPreset({ pool }, { maxRequests: 500 })));
 * ```
 * @see {@link failClosedPostgresPreset}
 * @since 3.3.0
 */
export function postgresPreset(
  pgOptions: PostgresPresetPgOptions,
  overrides?: Partial<RateLimitOptions>,
): Partial<RateLimitOptions> {
  const defaults: Partial<RateLimitOptions> = {
    maxRequests: 100,
    windowMs: 60_000,
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    inMemoryBlock: true,
  };
  const merged: Partial<RateLimitOptions> = { ...defaults, ...overrides };
  const store =
    merged.store ?? new PgStore(buildPresetPgStoreOptions(pgOptions.pool, merged));
  return { ...merged, store };
}

/**
 * Postgres preset with **`onPostgresError`: `fail-closed`** (requests count as blocked when the database errors).
 *
 * @remarks
 * This is **not** “resilient” in the {@link resilientRedisPreset} sense: there is **no** bundled insurance
 * store, circuit breaker, or automatic fallback—only fail-closed behavior on {@link PgStore}.
 * For **try Postgres, then memory** (parity with Redis’s preset), build {@link postgresInsuranceMemoryStore}
 * and {@link compose.firstAvailable} yourself, for example:
 *
 * ```ts
 * import { compose } from 'ratelimit-flex';
 * const workers = 4;
 * const globalMax = 200;
 * const pg = new PgStore({
 *   client: pool,
 *   strategy: RateLimitStrategy.SLIDING_WINDOW,
 *   windowMs: 60_000,
 *   maxRequests: globalMax,
 *   onPostgresError: 'fail-closed',
 * });
 * const insurance = new MemoryStore({
 *   strategy: RateLimitStrategy.SLIDING_WINDOW,
 *   windowMs: 60_000,
 *   maxRequests: Math.ceil(globalMax / workers),
 * });
 * const store = compose.firstAvailable([
 *   { label: 'pg', store: pg },
 *   { label: 'mem', store: insurance },
 * ]);
 * ```
 *
 * A future version may add first-class insurance / breaker on {@link PgStore} (closer to Redis).
 *
 * @param pgOptions - `{ pool }` — {@link PgClientLike}.
 * @param overrides - Same as {@link postgresPreset}, plus optional **`estimatedWorkers`** (see remarks). Token bucket: **`tokensPerInterval`**, **`interval`**, **`bucketSize`** are forwarded to {@link PgStore} like {@link postgresPreset}.
 * @returns Partial {@link RateLimitOptions} with a fail-closed {@link PgStore}.
 * @remarks
 * **`estimatedWorkers`:** Accepted only for forward-compatibility and parity with {@link resilientRedisPreset} call sites. It is **removed** from the returned options (so it never leaks into {@link RateLimitOptions}) and is **not used** for any sizing or {@link PgStore} configuration. To scale {@link postgresInsuranceMemoryStore}, pass the worker count as its second argument yourself.
 * @since 3.3.0
 */
export function failClosedPostgresPreset(
  pgOptions: PostgresPresetPgOptions,
  overrides?: Partial<RateLimitOptions> & { estimatedWorkers?: number },
): Partial<RateLimitOptions> {
  const raw = { ...(overrides ?? {}) };
  // Strip non-RateLimitOptions key; value is ignored here — see @remarks on failClosedPostgresPreset.
  delete (raw as { estimatedWorkers?: number }).estimatedWorkers;
  const rateLimitOverrides = raw as Partial<RateLimitOptions>;

  const defaults: Partial<RateLimitOptions> = {
    maxRequests: 100,
    windowMs: 60_000,
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    inMemoryBlock: true,
  };
  const merged: Partial<RateLimitOptions> = { ...defaults, ...rateLimitOverrides };
  const store =
    merged.store ??
    new PgStore(
      buildPresetPgStoreOptions(pgOptions.pool, merged, { onPostgresError: 'fail-closed' }),
    );
  return { ...merged, store };
}

/**
 * @deprecated Renamed to {@link failClosedPostgresPreset}. The old name suggested {@link resilientRedisPreset}-style
 *   insurance and circuit breaking; this helper only sets `onPostgresError: 'fail-closed'` on {@link PgStore}.
 * @param overrides - Same as {@link failClosedPostgresPreset} (including unused **`estimatedWorkers`** — see that function’s remarks).
 */
export function resilientPostgresPreset(
  pgOptions: PostgresPresetPgOptions,
  overrides?: Partial<RateLimitOptions> & { estimatedWorkers?: number },
): Partial<RateLimitOptions> {
  return failClosedPostgresPreset(pgOptions, overrides);
}

/**
 * Build a {@link MemoryStore} sized for per-replica insurance when using {@link failClosedPostgresPreset} with `compose.firstAvailable` (see `../composition/compose.js`).
 *
 * @param globalMax - Cluster-wide cap (same as {@link PgStore} `maxRequests`).
 * @param estimatedWorkers - Passed to {@link estimateWorkersFromEnvironment}; omit to detect from the environment.
 * @param windowMs - Sliding window length; **should match** the {@link PgStore} / {@link postgresPreset} `windowMs` so primary and insurance limits use the same horizon. Default: `60_000`.
 * @since 3.3.0
 */
export function postgresInsuranceMemoryStore(
  globalMax: number,
  estimatedWorkers?: number,
  windowMs?: number,
): MemoryStore {
  const workers = estimateWorkersFromEnvironment(estimatedWorkers);
  const wm = sanitizeWindowMs(windowMs, 60_000);
  return new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: wm,
    maxRequests: ceilDiv(globalMax, workers),
  });
}
