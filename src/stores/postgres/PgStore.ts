import type {
  RateLimitDecrementOptions,
  RateLimitIncrementOptions,
  RateLimitResult,
  RateLimitStore,
} from '../../types/index.js';
import { RateLimitStrategy } from '../../types/index.js';
import {
  sanitizeIncrementCost,
  sanitizeRateLimitCap,
  sanitizeWindowMs,
} from '../../utils/clamp.js';
import { num, refillBucketState, resetTimeDateFromSlidingStamps } from '../../utils/store-utils.js';
import type { PgClientLike, PgStoreOptions } from './types.js';

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertSafeTableName(name: string): string {
  if (!TABLE_NAME_RE.test(name)) {
    throw new Error(
      `PgStore: tableName must be a single unqualified identifier matching ${TABLE_NAME_RE} (schema-qualified names like "public.rate_limits" are not supported — use search_path on the connection). Got ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/**
 * Postgres-backed {@link RateLimitStore}.
 *
 * @description
 * - **Fixed window** — single-row UPSERT.
 * - **Token bucket** — transactional read / compute / write.
 * - **Sliding window** — one row per key; `hits` is a JSONB array of **epoch-ms strings**
 *   (text avoids JSON number precision loss). Pruned + appended in one `UPDATE` using
 *   `COALESCE(filtered_agg, '[]') || EXCLUDED.hits` (see {@link incrementSlidingWindow}).
 *   For **very large** caps (e.g. `maxRequests` &gt; 1000), JSONB payload and CPU per increment
 *   grow — prefer {@link RedisStore} or fixed window for huge limits.
 *
 * Requires a user-created table — see {@link pgStoreSchema} in `./schema.js`.
 * {@link PgStoreOptions.tableName} must be unqualified (no `schema.table`); use `search_path` for non-default schemas.
 * @since 3.3.0
 */
export class PgStore implements RateLimitStore {
  private readonly client: PgClientLike;

  private readonly strategy: RateLimitStrategy;

  private readonly windowMs: number;

  private readonly maxRequests: number;

  private readonly tokensPerInterval: number;

  private readonly refillIntervalMs: number;

  private readonly bucketSize: number;

  private readonly tableName: string;

  private readonly keyPrefix: string;

  private readonly onPostgresError: 'fail-open' | 'fail-closed';

  private readonly onWarn: (msg: string, err?: Error) => void;

  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PgStoreOptions) {
    if (!options.client) {
      throw new Error('PgStore: "client" is required');
    }
    this.client = options.client;
    this.strategy = options.strategy ?? RateLimitStrategy.SLIDING_WINDOW;
    this.windowMs = sanitizeWindowMs(options.windowMs, 60_000);
    this.maxRequests = sanitizeRateLimitCap(options.maxRequests, 100);
    this.tokensPerInterval = Math.max(1, Math.floor(options.tokensPerInterval ?? 10));
    this.refillIntervalMs = sanitizeWindowMs(options.interval, 60_000);
    this.bucketSize = sanitizeRateLimitCap(options.bucketSize, 100);
    this.tableName = assertSafeTableName(options.tableName ?? 'rate_limits');
    this.keyPrefix = options.keyPrefix ?? 'rlf:';
    this.onPostgresError = options.onPostgresError ?? 'fail-open';
    this.onWarn = options.onWarn ?? ((msg, err) => console.warn(`[ratelimit-flex] ${msg}`, err ?? ''));

    const sweepMs = options.autoSweepIntervalMs ?? 60_000;
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.sweep();
      }, sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  async increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult> {
    const prefixedKey = this.keyPrefix + key;
    const cost = sanitizeIncrementCost(options?.cost, 1);
    const maxRequests =
      this.strategy === RateLimitStrategy.TOKEN_BUCKET
        ? this.bucketSize
        : sanitizeRateLimitCap(options?.maxRequests ?? this.maxRequests, this.maxRequests);

    try {
      switch (this.strategy) {
        case RateLimitStrategy.FIXED_WINDOW:
          return await this.incrementFixedWindow(prefixedKey, cost, maxRequests);
        case RateLimitStrategy.TOKEN_BUCKET:
          return await this.incrementTokenBucket(prefixedKey, cost);
        case RateLimitStrategy.SLIDING_WINDOW:
          return await this.incrementSlidingWindow(prefixedKey, cost, maxRequests);
        default: {
          const _: never = this.strategy;
          throw new Error(`Unknown strategy: ${String(_)}`);
        }
      }
    } catch (err) {
      if (this.isNonPostgresError(err)) {
        throw err;
      }
      return this.handleError(err, maxRequests);
    }
  }

  /** Programmer errors (e.g. not implemented) must not become fail-open quota. */
  private isNonPostgresError(err: unknown): boolean {
    return err instanceof Error && err.message.startsWith('PgStore:');
  }

  /**
   * Fixed window: single UPSERT with CASE logic for window expiry.
   */
  private async incrementFixedWindow(
    key: string,
    cost: number,
    maxRequests: number,
  ): Promise<RateLimitResult> {
    const nowMs = Date.now();
    const windowMs = this.windowMs;
    const t = this.tableName;
    const nowDate = new Date(nowMs);
    const windowEnd = new Date(nowMs + windowMs);

    const sql = `
      INSERT INTO ${t} (key, total_hits, reset_at, hits, tokens, last_refill_at)
      VALUES ($1::text, $2::bigint, $3::timestamptz, NULL, NULL, NULL)
      ON CONFLICT (key) DO UPDATE SET
        total_hits = CASE
          WHEN ${t}.reset_at <= $4::timestamptz
            THEN EXCLUDED.total_hits
          ELSE ${t}.total_hits + EXCLUDED.total_hits
        END,
        reset_at = CASE
          WHEN ${t}.reset_at <= $4::timestamptz
            THEN EXCLUDED.reset_at
          ELSE ${t}.reset_at
        END
      RETURNING total_hits, (EXTRACT(EPOCH FROM reset_at) * 1000)::double precision AS reset_at_ms
    `;

    const result = await this.client.query(sql, [key, cost, windowEnd, nowDate]);
    const row = result.rows[0];
    if (!row) {
      throw new Error('PgStore: fixed window increment returned no row');
    }
    const totalHits = num(row['total_hits']);
    const resetMs = num(row['reset_at_ms']);
    const resetTime = new Date(resetMs);

    const isBlocked = totalHits > maxRequests;
    const remaining = isBlocked ? 0 : Math.max(0, maxRequests - totalHits);

    return {
      totalHits,
      remaining,
      resetTime,
      isBlocked,
    };
  }

  /**
   * Token bucket: transactional read–compute–write (same semantics as {@link MemoryStore}).
   */
  private async incrementTokenBucket(key: string, cost: number): Promise<RateLimitResult> {
    const now = Date.now();
    const bs = this.bucketSize;
    const tpi = this.tokensPerInterval;
    const interval = this.refillIntervalMs;
    const t = this.tableName;

    return this.withTransaction(async (exec) => {
      const sel = await exec.query(
        `SELECT tokens, last_refill_at
         FROM ${t}
         WHERE key = $1::text
         FOR UPDATE`,
        [key],
      );

      let tokens: number;
      let lastRefillMs: number;

      if (sel.rows.length === 0) {
        tokens = bs;
        lastRefillMs = now;
      } else {
        const row = sel.rows[0]!;
        const tok = row['tokens'];
        const lr = row['last_refill_at'];
        tokens = typeof tok === 'number' ? tok : Number(tok);
        if (lr instanceof Date) {
          lastRefillMs = lr.getTime();
        } else if (typeof lr === 'string' || typeof lr === 'number') {
          lastRefillMs = new Date(lr).getTime();
        } else {
          throw new Error('PgStore: invalid last_refill_at');
        }
      }

      const refilled = refillBucketState(tokens, lastRefillMs, now, bs, tpi, interval);

      let newTokens: number;
      let newLastRefillMs: number;
      let isBlocked: boolean;
      let resetTime: Date;

      if (refilled.tokens >= cost) {
        newTokens = refilled.tokens - cost;
        newLastRefillMs = refilled.lastRefillMs;
        isBlocked = false;
        resetTime = new Date(newLastRefillMs + interval);
      } else {
        newTokens = refilled.tokens;
        newLastRefillMs = refilled.lastRefillMs;
        isBlocked = true;
        const nextRefillAt = newLastRefillMs + interval;
        resetTime = new Date(nextRefillAt);
      }

      const totalHits = isBlocked ? bs : bs - newTokens;
      const remaining = isBlocked ? 0 : newTokens;

      const upsert = `
        INSERT INTO ${t} (key, total_hits, reset_at, hits, tokens, last_refill_at)
        VALUES (
          $1::text,
          $2::bigint,
          $3::timestamptz,
          NULL,
          $4::double precision,
          $5::timestamptz
        )
        ON CONFLICT (key) DO UPDATE SET
          total_hits = EXCLUDED.total_hits,
          reset_at = EXCLUDED.reset_at,
          tokens = EXCLUDED.tokens,
          last_refill_at = EXCLUDED.last_refill_at
      `;

      await exec.query(upsert, [
        key,
        Math.round(totalHits),
        resetTime,
        newTokens,
        new Date(newLastRefillMs),
      ]);

      return {
        totalHits,
        remaining,
        resetTime,
        isBlocked,
      };
    });
  }

  /**
   * Sliding window: JSONB array of epoch-ms **strings** (multiset of hit times).
   * Prune entries with `ts <= windowStartMs`, append `cost` copies of `nowMs` via `|| EXCLUDED.hits`.
   *
   * Uses a CTE to compute the merged array once (avoids 3x evaluation in SET clause).
   * Stored `reset_at` is **newest hit + window** (sweep retention); API `resetTime` uses oldest hit + window
   * via {@link resetTimeFromSlidingHitsRow} (matches MemoryStore).
   */
  private async incrementSlidingWindow(
    key: string,
    cost: number,
    maxRequests: number,
  ): Promise<RateLimitResult> {
    const nowMs = Date.now();
    const windowMs = this.windowMs;
    const windowStartMs = nowMs - windowMs;
    const newEntries = Array.from({ length: cost }, () => String(nowMs));
    const hitsJson = JSON.stringify(newEntries);
    const initialResetAt = new Date(nowMs + windowMs);
    const t = this.tableName;

    // Use a function to compute merged hits once in ON CONFLICT clause
    const sql = `
      INSERT INTO ${t} (key, total_hits, reset_at, hits, tokens, last_refill_at)
      VALUES (
        $1::text,
        (SELECT COUNT(*)::bigint FROM jsonb_array_elements_text($5::jsonb)),
        $2::timestamptz,
        $5::jsonb,
        NULL,
        NULL
      )
      ON CONFLICT (key) DO UPDATE SET
        hits = (
          WITH filtered AS (
            SELECT COALESCE(
              (
                SELECT jsonb_agg(elem::text ORDER BY elem::bigint)
                FROM jsonb_array_elements_text(${t}.hits) AS e(elem)
                WHERE e.elem::bigint > $3::bigint
              ),
              '[]'::jsonb
            ) AS old_hits
          )
          SELECT old_hits || $5::jsonb FROM filtered
        ),
        total_hits = jsonb_array_length(
          (
            WITH filtered AS (
              SELECT COALESCE(
                (
                  SELECT jsonb_agg(elem::text ORDER BY elem::bigint)
                  FROM jsonb_array_elements_text(${t}.hits) AS e(elem)
                  WHERE e.elem::bigint > $3::bigint
                ),
                '[]'::jsonb
              ) AS old_hits
            )
            SELECT old_hits || $5::jsonb FROM filtered
          )
        ),
        reset_at = to_timestamp(COALESCE(
          (
            SELECT MAX(elem::bigint)
            FROM jsonb_array_elements_text(
              (
                WITH filtered AS (
                  SELECT COALESCE(
                    (
                      SELECT jsonb_agg(elem::text ORDER BY elem::bigint)
                      FROM jsonb_array_elements_text(${t}.hits) AS e(elem)
                      WHERE e.elem::bigint > $3::bigint
                    ),
                    '[]'::jsonb
                  ) AS old_hits
                )
                SELECT old_hits || $5::jsonb FROM filtered
              )
            ) AS m(elem)
          ),
          $3::bigint + $4::bigint
        ) / 1000.0)
      RETURNING total_hits, hits
    `;

    const result = await this.client.query(sql, [
      key,
      initialResetAt,
      windowStartMs,
      windowMs,
      hitsJson,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error('PgStore: sliding window increment returned no row');
    }
    const totalHits = num(row['total_hits']);
    const resetTime = this.resetTimeFromSlidingHitsRow(row['hits'], windowMs, nowMs);
    const isBlocked = totalHits > maxRequests;
    const remaining = isBlocked ? 0 : Math.max(0, maxRequests - totalHits);

    return {
      totalHits,
      remaining,
      resetTime,
      isBlocked,
    };
  }

  /** Oldest remaining hit + window length (matches {@link MemoryStore} sliding semantics). */
  private resetTimeFromSlidingHitsRow(hits: unknown, windowMs: number, nowMs: number): Date {
    return resetTimeDateFromSlidingStamps(this.parseSlidingHitsJson(hits), windowMs, nowMs);
  }

  private parseSlidingHitsJson(hits: unknown): number[] {
    if (hits === null || hits === undefined) {
      return [];
    }
    let raw: unknown = hits;
    if (typeof hits === 'string') {
      try {
        raw = JSON.parse(hits) as unknown;
      } catch {
        return [];
      }
    }
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: number[] = [];
    for (const x of raw) {
      const n = Number(x);
      if (Number.isFinite(n)) {
        out.push(n);
      }
    }
    return out;
  }

  /**
   * Sliding decrement: prune **`cost`** entries using JSON array order (append order).
   * **FIFO** (default): remove oldest hits — keep the **`len − cost`** newest elements.
   * **LIFO** (`removeNewest: true`): remove newest — keep the **`len − cost`** oldest elements (rollback probes).
   */
  private async decrementSliding(key: string, cost: number, removeNewest: boolean): Promise<void> {
    const t = this.tableName;
    const windowMs = this.windowMs;
    await this.withTransaction(async (exec) => {
      const sel = await exec.query(
        `SELECT jsonb_array_length(COALESCE(hits, '[]'::jsonb))::int AS len
         FROM ${t} WHERE key = $1::text FOR UPDATE`,
        [key],
      );
      if (sel.rows.length === 0) {
        return;
      }
      const len = Math.max(0, Math.floor(num(sel.rows[0]!['len'])));
      if (len === 0 || len <= cost) {
        await exec.query(`DELETE FROM ${t} WHERE key = $1::text`, [key]);
        return;
      }
      const keepCount = len - cost;
      const fifo = !removeNewest;
      const orderDesc = fifo ? 'DESC' : 'ASC';
      const sql = `
        WITH kept AS (
          SELECT t.ts, t.ord
          FROM ${t}, jsonb_array_elements_text(COALESCE(${t}.hits, '[]'::jsonb)) WITH ORDINALITY AS t(ts, ord)
          WHERE ${t}.key = $1::text
          ORDER BY t.ord ${orderDesc}
          LIMIT $2::int
        )
        UPDATE ${t}
        SET
          hits = (SELECT COALESCE(jsonb_agg(kept.ts ORDER BY kept.ord), '[]'::jsonb) FROM kept),
          total_hits = (SELECT COUNT(*)::bigint FROM kept),
          reset_at = to_timestamp((
            COALESCE(
              (SELECT MAX(kept.ts::bigint) FROM kept),
              EXTRACT(EPOCH FROM NOW()) * 1000
            ) + $3::bigint
          ) / 1000.0)
        WHERE key = $1::text
      `;
      await exec.query(sql, [key, keepCount, windowMs]);
    });
  }

  async decrement(key: string, options?: RateLimitDecrementOptions): Promise<void> {
    const prefixedKey = this.keyPrefix + key;
    const cost = sanitizeIncrementCost(options?.cost, 1);
    const t = this.tableName;
    try {
      switch (this.strategy) {
        case RateLimitStrategy.FIXED_WINDOW: {
          await this.client.query(
            `UPDATE ${t}
             SET total_hits = GREATEST(0::bigint, total_hits - $2::bigint)
             WHERE key = $1::text`,
            [prefixedKey, cost],
          );
          break;
        }
        case RateLimitStrategy.TOKEN_BUCKET: {
          const bs = this.bucketSize;
          await this.client.query(
            `UPDATE ${t}
             SET tokens = new_tok.val,
                 total_hits = ($3::numeric - new_tok.val::numeric)::bigint
             FROM (
               SELECT LEAST($3::double precision, COALESCE(${t}.tokens, $3::double precision) + $2::double precision) AS val
               FROM ${t}
               WHERE ${t}.key = $1::text
             ) AS new_tok
             WHERE ${t}.key = $1::text`,
            [prefixedKey, cost, bs],
          );
          break;
        }
        case RateLimitStrategy.SLIDING_WINDOW: {
          await this.decrementSliding(prefixedKey, cost, options?.removeNewest === true);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.onWarn('PgStore decrement failed', err instanceof Error ? err : new Error(String(err)));
      if (this.onPostgresError === 'fail-closed') {
        throw err;
      }
    }
  }

  async reset(key: string): Promise<void> {
    const prefixedKey = this.keyPrefix + key;
    try {
      await this.client.query(`DELETE FROM ${this.tableName} WHERE key = $1::text`, [prefixedKey]);
    } catch (err) {
      this.onWarn('PgStore reset failed', err instanceof Error ? err : new Error(String(err)));
      if (this.onPostgresError === 'fail-closed') {
        throw err;
      }
    }
  }

  /**
   * Stops the background sweep timer only. Does **not** close or end the Postgres client — the caller owns the pool.
   */
  async shutdown(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Deletes rows with `reset_at < now()`. Used by the background timer; safe to call manually.
   * For sliding window, `reset_at` is newest-hit expiry so rows are not removed while any hit is active.
   * Failures are logged via {@link PgStoreOptions.onWarn} and **0** is returned — never throws.
   */
  async sweep(): Promise<number> {
    try {
      const r = await this.client.query(`DELETE FROM ${this.tableName} WHERE reset_at < NOW()`, []);
      return r.rowCount ?? 0;
    } catch (err) {
      this.onWarn('PgStore sweep failed', err instanceof Error ? err : new Error(String(err)));
      return 0;
    }
  }

  async get(key: string): Promise<{
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  } | null> {
    const prefixedKey = this.keyPrefix + key;
    const t = this.tableName;
    const nowMs = Date.now();
    try {
      if (this.strategy === RateLimitStrategy.FIXED_WINDOW) {
        const r = await this.client.query(
          `SELECT total_hits, reset_at FROM ${t} WHERE key = $1::text`,
          [prefixedKey],
        );
        if (r.rows.length === 0) {
          return null;
        }
        const row = r.rows[0]!;
        const ra = row['reset_at'];
        const resetAtMs =
          ra instanceof Date ? ra.getTime() : new Date(String(ra)).getTime();
        if (resetAtMs <= nowMs) {
          return null;
        }
        const totalHits = num(row['total_hits']);
        const cap = this.maxRequests;
        const isBlocked = totalHits > cap;
        const remaining = isBlocked ? 0 : Math.max(0, cap - totalHits);
        return {
          totalHits,
          remaining,
          resetTime: new Date(resetAtMs),
          isBlocked,
        };
      }
      if (this.strategy === RateLimitStrategy.TOKEN_BUCKET) {
        const r = await this.client.query(
          `SELECT tokens, last_refill_at FROM ${t} WHERE key = $1::text`,
          [prefixedKey],
        );
        if (r.rows.length === 0) {
          return null;
        }
        const row = r.rows[0]!;
        let tokens = num(row['tokens']);
        const lr = row['last_refill_at'];
        const lastRefillMs =
          lr instanceof Date ? lr.getTime() : new Date(String(lr)).getTime();
        const ref = refillBucketState(
          tokens,
          lastRefillMs,
          nowMs,
          this.bucketSize,
          this.tokensPerInterval,
          this.refillIntervalMs,
        );
        tokens = ref.tokens;
        const totalHits = this.bucketSize - tokens;
        const remaining = tokens;
        const isBlocked = remaining === 0 && totalHits >= this.bucketSize;
        const resetTime = new Date(ref.lastRefillMs + this.refillIntervalMs);
        return { totalHits, remaining, resetTime, isBlocked };
      }
      if (this.strategy === RateLimitStrategy.SLIDING_WINDOW) {
        const r = await this.client.query(`SELECT hits FROM ${t} WHERE key = $1::text`, [prefixedKey]);
        if (r.rows.length === 0) {
          return null;
        }
        const cutoff = nowMs - this.windowMs;
        // Live count from `hits` only — `total_hits` on the row may be stale if time passed without an increment.
        const stamps = this.parseSlidingHitsJson(r.rows[0]!['hits']).filter((ts) => ts > cutoff);
        if (stamps.length === 0) {
          return null;
        }
        const cap = this.maxRequests;
        const totalHits = stamps.length;
        const isBlocked = totalHits > cap;
        const remaining = isBlocked ? 0 : Math.max(0, cap - totalHits);
        const resetTime = resetTimeDateFromSlidingStamps(stamps, this.windowMs, nowMs);
        return { totalHits, remaining, resetTime, isBlocked };
      }
    } catch (err) {
      this.onWarn('PgStore get failed', err instanceof Error ? err : new Error(String(err)));
      return null;
    }
    return null;
  }

  async set(
    key: string,
    totalHits: number,
    expiresAt?: Date,
  ): Promise<{
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  }> {
    const prefixedKey = this.keyPrefix + key;
    const t = this.tableName;
    const now = Date.now();
    if (this.strategy === RateLimitStrategy.FIXED_WINDOW) {
      const n = Math.max(0, Math.floor(totalHits));
      const cap = this.maxRequests;
      const resetAt = expiresAt ?? new Date(now + this.windowMs);
      await this.client.query(
        `INSERT INTO ${t} (key, total_hits, reset_at, hits, tokens, last_refill_at)
         VALUES ($1::text, $2::bigint, $3::timestamptz, NULL, NULL, NULL)
         ON CONFLICT (key) DO UPDATE SET
           total_hits = EXCLUDED.total_hits,
           reset_at = EXCLUDED.reset_at`,
        [prefixedKey, n, resetAt],
      );
      const isBlocked = n > cap;
      const remaining = isBlocked ? 0 : Math.max(0, cap - n);
      return {
        totalHits: n,
        remaining,
        resetTime: resetAt,
        isBlocked,
      };
    }
    if (this.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      const cap = this.bucketSize;
      const th = Math.max(0, Math.floor(totalHits));
      const blocked = th >= cap;
      const tokens = blocked ? 0 : Math.max(0, cap - th);
      const totalHitsOut = blocked ? cap : th;
      const resetTime = new Date(now + this.refillIntervalMs);
      await this.client.query(
        `INSERT INTO ${t} (key, total_hits, reset_at, hits, tokens, last_refill_at)
         VALUES ($1::text, $2::bigint, $3::timestamptz, NULL, $4::double precision, $5::timestamptz)
         ON CONFLICT (key) DO UPDATE SET
           total_hits = EXCLUDED.total_hits,
           reset_at = EXCLUDED.reset_at,
           tokens = EXCLUDED.tokens,
           last_refill_at = EXCLUDED.last_refill_at`,
        [prefixedKey, totalHitsOut, resetTime, tokens, new Date(now)],
      );
      return {
        totalHits: totalHitsOut,
        remaining: tokens,
        resetTime,
        isBlocked: blocked,
      };
    }
    if (this.strategy === RateLimitStrategy.SLIDING_WINDOW) {
      const cap = this.maxRequests;
      const n = Math.max(0, Math.floor(totalHits));
      const stamps = Array.from({ length: n }, () => String(now));
      const hitsJson = JSON.stringify(stamps);
      const resetAt = expiresAt ?? new Date(now + this.windowMs);
      await this.client.query(
        `INSERT INTO ${t} (key, total_hits, reset_at, hits, tokens, last_refill_at)
         VALUES ($1::text, $2::bigint, $3::timestamptz, $4::jsonb, NULL, NULL)
         ON CONFLICT (key) DO UPDATE SET
           total_hits = EXCLUDED.total_hits,
           reset_at = EXCLUDED.reset_at,
           hits = EXCLUDED.hits`,
        [prefixedKey, n, resetAt, hitsJson],
      );
      const isBlocked = n > cap;
      const remaining = isBlocked ? 0 : Math.max(0, cap - n);
      return {
        totalHits: n,
        remaining,
        resetTime: resetAt,
        isBlocked,
      };
    }
    throw new Error('PgStore.set: unsupported strategy');
  }

  async delete(key: string): Promise<boolean> {
    const prefixedKey = this.keyPrefix + key;
    try {
      const r = await this.client.query(
        `DELETE FROM ${this.tableName} WHERE key = $1::text RETURNING key`,
        [prefixedKey],
      );
      return r.rows.length > 0;
    } catch (err) {
      this.onWarn('PgStore delete failed', err instanceof Error ? err : new Error(String(err)));
      if (this.onPostgresError === 'fail-closed') {
        throw err;
      }
      return false;
    }
  }

  private handleError(err: unknown, cap: number): RateLimitResult {
    const e = err instanceof Error ? err : new Error(String(err));
    this.onWarn('PgStore error', e);
    const offsetMs =
      this.strategy === RateLimitStrategy.TOKEN_BUCKET ? this.refillIntervalMs : this.windowMs;
    if (this.onPostgresError === 'fail-closed') {
      return {
        totalHits: cap + 1,
        remaining: 0,
        resetTime: new Date(Date.now() + offsetMs),
        isBlocked: true,
        storeUnavailable: true,
      };
    }
    return {
      totalHits: 0,
      remaining: cap,
      resetTime: new Date(Date.now() + offsetMs),
      isBlocked: false,
      storeUnavailable: true,
    };
  }

  /**
   * Runs `fn` on one connection so token-bucket math stays atomic with `pg.Pool`.
   */
  private async withTransaction<T>(fn: (exec: PgClientLike) => Promise<T>): Promise<T> {
    if (typeof this.client.connect === 'function') {
      const conn = await this.client.connect();
      const exec: PgClientLike = {
        query: (text, values) => conn.query(text, values),
      };
      try {
        await exec.query('BEGIN');
        const out = await fn(exec);
        await exec.query('COMMIT');
        return out;
      } catch (err) {
        await exec.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        await Promise.resolve(conn.release());
      }
    }

    await this.client.query('BEGIN');
    try {
      const out = await fn(this.client);
      await this.client.query('COMMIT');
      return out;
    } catch (err) {
      await this.client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }
}
