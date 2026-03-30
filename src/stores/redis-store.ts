import type {
  RateLimitIncrementOptions,
  RateLimitResult,
  RateLimitStore,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { sanitizeRateLimitCap, sanitizeWindowMs } from '../utils/clamp.js';

/** Window-based strategies (sliding / fixed). */
export type RedisStoreWindowOptions = {
  strategy: RateLimitStrategy.SLIDING_WINDOW | RateLimitStrategy.FIXED_WINDOW;
  windowMs: number;
  maxRequests: number;
};

/** Token-bucket strategy. */
export type RedisStoreTokenBucketOptions = {
  strategy: RateLimitStrategy.TOKEN_BUCKET;
  tokensPerInterval: number;
  interval: number;
  bucketSize: number;
};

export type RedisStoreStrategyOptions = RedisStoreWindowOptions | RedisStoreTokenBucketOptions;

/**
 * Minimal Redis surface used by {@link RedisStore}.
 * Matches common `EVAL` calling conventions (e.g. ioredis: `eval(script, numKeys, ...keys, ...args)`).
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  /**
   * `EVAL` / `EVALSHA` compatible entry point (ioredis-style):
   * `eval(script, numKeys, key1, key2, ..., arg1, arg2, ...)`.
   */
  eval(script: string, numKeys: number, ...keysAndArgs: string[]): Promise<unknown>;
  del?: (...keys: string[]) => Promise<unknown>;
  quit?: () => Promise<unknown>;
  disconnect?: () => void | Promise<void>;
}

/**
 * How {@link RedisStore} behaves when Redis is unreachable or returns an error.
 * - `fail-open` (default): allow traffic through; log a warning.
 * - `fail-closed`: treat as blocked with {@link RateLimitResult.storeUnavailable}; middleware responds with HTTP 503.
 */
export type RedisErrorMode = 'fail-open' | 'fail-closed';

export type RedisStoreOptions = RedisStoreStrategyOptions & {
  /** Existing Redis client — use {@link adaptIoRedisClient} / {@link adaptNodeRedisClient} if needed. */
  client?: RedisLikeClient;
  /**
   * Connection URL. Requires optional peer dependency `ioredis` (dynamic import).
   * Do not pass both `url` and `client`.
   */
  url?: string;
  /** Prefix for all keys. @default "rlf:" */
  keyPrefix?: string;
  /**
   * Invoked on Redis errors (connection, eval, etc.). Defaults to `console.warn`.
   * Errors are swallowed after warning so your HTTP server keeps running.
   */
  onWarn?: (message: string, error?: unknown) => void;
  /**
   * When Redis cannot be reached or a command fails.
   * @default 'fail-open'
   */
  onRedisError?: RedisErrorMode;
};

const DEFAULT_PREFIX = 'rlf:';

/** Sliding window: ZSET prune + ZADD + ZCARD. KEYS[1]=zset, ARGV: now, windowMs, maxRequests, member */
const LUA_SLIDING_INCR = `
local zkey = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', zkey, '-inf', now - window_ms)
redis.call('ZADD', zkey, now, member)
local count = tonumber(redis.call('ZCARD', zkey))
redis.call('PEXPIRE', zkey, window_ms)

local blocked = 0
if count > max_requests then blocked = 1 end

local oldest_score = now
if count > 0 then
  local r = redis.call('ZRANGE', zkey, 0, 0, 'WITHSCORES')
  if r[2] ~= nil then
    oldest_score = tonumber(r[2])
  end
end
local reset_at = oldest_score + window_ms

return { count, blocked, reset_at }
`;

const LUA_SLIDING_DECR = `
redis.call('ZPOPMAX', KEYS[1])
return 1
`;

/** Fixed window: atomic INCR + PEXPIRE on first hit. KEYS[1]=counter, ARGV: windowMs, maxRequests, now */
const LUA_FIXED_INCR = `
local k = KEYS[1]
local window_ms = tonumber(ARGV[1])
local max_requests = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local current = tonumber(redis.call('INCR', k))
if current == 1 then
  redis.call('PEXPIRE', k, window_ms)
end

local pttl = tonumber(redis.call('PTTL', k))
if pttl < 0 then pttl = window_ms end
local reset_at = now + pttl

local blocked = 0
if current > max_requests then blocked = 1 end

return { current, blocked, reset_at }
`;

const LUA_FIXED_DECR = `
local k = KEYS[1]
local v = tonumber(redis.call('GET', k) or '0')
if v > 0 then
  redis.call('DECR', k)
end
return v
`;

/** Token bucket: HSET tokens + last_refill. KEYS[1]=hash, ARGV: now, tpi, interval_ms, bucket_size */
const LUA_BUCKET_INCR = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local tokens_per_interval = tonumber(ARGV[2])
local interval_ms = tonumber(ARGV[3])
local bucket_size = tonumber(ARGV[4])

local tokens_s = redis.call('HGET', key, 'tokens')
local last_s = redis.call('HGET', key, 'last_refill')

local tokens
local last_refill

if tokens_s == false then
  tokens = bucket_size
  last_refill = now
else
  tokens = tonumber(tokens_s)
  last_refill = tonumber(last_s)
end

local elapsed = now - last_refill
local intervals = math.floor(elapsed / interval_ms)
if intervals > 0 then
  tokens = math.min(bucket_size, tokens + intervals * tokens_per_interval)
  last_refill = last_refill + intervals * interval_ms
end

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HSET', key, 'tokens', tostring(tokens), 'last_refill', tostring(last_refill))
  redis.call('PEXPIRE', key, interval_ms * 10)
  local remaining = tokens
  local total_hits = bucket_size - remaining
  local next_tick = last_refill + interval_ms
  return { 1, remaining, total_hits, 0, next_tick }
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'last_refill', tostring(last_refill))
redis.call('PEXPIRE', key, interval_ms * 10)
local next_refill = last_refill + interval_ms
return { 0, tokens, bucket_size, 1, next_refill }
`;

const LUA_BUCKET_DECR = `
local key = KEYS[1]
local bucket_size = tonumber(ARGV[1])
local tokens_s = redis.call('HGET', key, 'tokens')
local tokens
if tokens_s == false then
  return 0
end
tokens = tonumber(tokens_s)
tokens = math.min(bucket_size, tokens + 1)
redis.call('HSET', key, 'tokens', tostring(tokens))
return 1
`;

const LUA_DEL = `
return redis.call('DEL', unpack(KEYS))
`;

/**
 * Wrap an **ioredis** client instance to satisfy {@link RedisLikeClient} without adding a compile-time dependency.
 */
export function adaptIoRedisClient(client: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  del?: (...keys: string[]) => Promise<unknown>;
  quit?: () => Promise<unknown>;
  disconnect?: () => void | Promise<void>;
}): RedisLikeClient {
  return {
    get: (k) => client.get(k),
    set: (k, v, ...rest) => client.set(k, v, ...rest),
    eval: (script, numKeys, ...rest) => client.eval(script, numKeys, ...rest.map((a) => String(a))),
    del: client.del?.bind(client),
    quit: client.quit?.bind(client),
    disconnect: client.disconnect ? async () => await client.disconnect!() : undefined,
  };
}

/**
 * Wrap **node-redis** v4+ clients (`eval(script, { keys, arguments })`).
 * Does not add a `redis` package dependency — pass your connected client instance.
 */
export function adaptNodeRedisClient(client: {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  del?: (...keys: string[]) => Promise<unknown>;
  quit?: () => Promise<unknown>;
  disconnect?: () => void | Promise<void>;
}): RedisLikeClient {
  return {
    get: async (k) => (await client.get(k)) ?? null,
    set: (k, v, ...rest) => client.set(k, v, ...rest),
    eval: (script, numKeys, ...rest) => {
      const keys = rest.slice(0, numKeys);
      const args = rest.slice(numKeys);
      return client.eval(script, { keys, arguments: args });
    },
    del: client.del?.bind(client),
    quit: client.quit?.bind(client),
    disconnect: client.disconnect ? async () => await client.disconnect!() : undefined,
  };
}

type IoRedisInstance = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  del?: (...keys: string[]) => Promise<unknown>;
  quit?: () => Promise<unknown>;
  disconnect?: () => void | Promise<void>;
};

/**
 * Redis-backed {@link RateLimitStore} using Lua for atomicity.
 *
 * Pass either `client` (recommended) or `url` (loads optional peer `ioredis` at runtime).
 */
export class RedisStore implements RateLimitStore {
  private readonly strategy: RateLimitStrategy;

  private readonly windowMs: number;

  private readonly maxRequests: number;

  private readonly tokensPerInterval: number;

  private readonly refillIntervalMs: number;

  private readonly bucketSize: number;

  private readonly keyPrefix: string;

  private readonly onWarn: (message: string, error?: unknown) => void;

  private readonly redisErrorMode: RedisErrorMode;

  private client: RedisLikeClient | null = null;

  /** After the first failed connect, avoid repeated awaits on a rejected promise. */
  private connectionFailed = false;

  private readonly clientPromise: Promise<RedisLikeClient>;

  /** Connection created from `url` — closed on {@link RedisStore.shutdown}. */
  private ownedRedis: IoRedisInstance | null = null;

  constructor(options: RedisStoreOptions) {
    if (options.url && options.client) {
      throw new Error('RedisStore: pass either "url" or "client", not both');
    }
    if (!options.url && !options.client) {
      throw new Error('RedisStore: pass "url" or "client"');
    }

    this.strategy = options.strategy;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_PREFIX;
    this.onWarn =
      options.onWarn ?? ((msg, err) => console.warn(`[ratelimit-flex] ${msg}`, err ?? ''));
    this.redisErrorMode = options.onRedisError ?? 'fail-open';

    if (options.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      this.windowMs = 0;
      this.maxRequests = 0;
      this.tokensPerInterval = options.tokensPerInterval;
      this.refillIntervalMs = options.interval;
      this.bucketSize = options.bucketSize;
    } else {
      this.windowMs = sanitizeWindowMs(options.windowMs, 60_000);
      this.maxRequests = sanitizeRateLimitCap(options.maxRequests, 100);
      this.tokensPerInterval = 0;
      this.refillIntervalMs = 0;
      this.bucketSize = 0;
    }

    if (options.client) {
      this.clientPromise = Promise.resolve(options.client);
    } else {
      this.clientPromise = this.connectFromUrl(options.url as string);
    }
  }

  private async connectFromUrl(url: string): Promise<RedisLikeClient> {
    try {
      // @ts-expect-error - ioredis is an optional peer dependency
      const mod = (await import('ioredis')) as { default: new (u: string) => unknown };
      const Redis = mod.default;
      const raw = new Redis(url) as IoRedisInstance;
      this.ownedRedis = raw;
      return adaptIoRedisClient(raw);
    } catch (err) {
      this.onWarn(
        'Failed to load optional peer "ioredis". Install it or pass a pre-configured "client".',
        err,
      );
      throw err;
    }
  }

  private warn(message: string, error?: unknown): void {
    this.onWarn(message, error);
  }

  private async getClient(): Promise<RedisLikeClient | null> {
    if (this.connectionFailed) {
      return null;
    }
    if (this.client) {
      return this.client;
    }
    try {
      const c = await this.clientPromise;
      this.client = c;
      return c;
    } catch (err) {
      this.connectionFailed = true;
      this.warn('Redis client unavailable', err);
      return null;
    }
  }

  private redisKey(kind: 'sw' | 'fw' | 'tb', key: string): string {
    return `${this.keyPrefix}${kind}:${key}`;
  }

  private async evalScript(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown | null> {
    try {
      const r = await this.getClient();
      if (r === null) {
        return null;
      }
      const flat = [...keys.map(String), ...args.map(String)];
      return await r.eval(script, keys.length, ...flat);
    } catch (err) {
      this.warn('Redis EVAL failed', err);
      return null;
    }
  }

  private async delKeys(...keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    try {
      const r = await this.getClient();
      if (r === null) {
        this.warn('Redis client unavailable (DEL)');
        if (this.redisErrorMode === 'fail-closed') {
          throw new Error('Redis client unavailable');
        }
        return;
      }
      if (r.del) {
        await r.del(...keys);
        return;
      }
      await r.eval(LUA_DEL, keys.length, ...keys.map(String));
    } catch (err) {
      this.warn('Redis DEL failed', err);
      if (this.redisErrorMode === 'fail-closed') {
        throw err;
      }
    }
  }

  private failOpenResult(): RateLimitResult {
    const now = Date.now();
    if (this.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      return {
        totalHits: 0,
        remaining: this.bucketSize,
        resetTime: new Date(now + this.refillIntervalMs),
        isBlocked: false,
      };
    }
    return {
      totalHits: 0,
      remaining: this.maxRequests,
      resetTime: new Date(now + this.windowMs),
      isBlocked: false,
    };
  }

  /** Blocked result when Redis cannot evaluate the limit (fail-closed mode). */
  private failClosedIncrementResult(): RateLimitResult {
    const now = Date.now();
    if (this.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      return {
        totalHits: this.bucketSize,
        remaining: 0,
        resetTime: new Date(now + this.refillIntervalMs),
        isBlocked: true,
        storeUnavailable: true,
      };
    }
    return {
      totalHits: 0,
      remaining: 0,
      resetTime: new Date(now + this.windowMs),
      isBlocked: true,
      storeUnavailable: true,
    };
  }

  private redisIncrementFailure(): RateLimitResult {
    this.warn(
      this.redisErrorMode === 'fail-closed'
        ? 'Redis unavailable; failing closed (request blocked)'
        : 'Redis unavailable; failing open (request allowed)',
    );
    if (this.redisErrorMode === 'fail-closed') {
      return this.failClosedIncrementResult();
    }
    return this.failOpenResult();
  }

  /** @inheritdoc */
  async increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult> {
    const maxOverride = options?.maxRequests;
    try {
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW:
          return await this.incrSliding(key, maxOverride);
        case RateLimitStrategy.FIXED_WINDOW:
          return await this.incrFixed(key, maxOverride);
        case RateLimitStrategy.TOKEN_BUCKET:
          return await this.incrBucket(key);
        default: {
          const _: never = this.strategy;
          return Promise.reject(new Error(`Unsupported strategy: ${String(_)}`));
        }
      }
    } catch (err) {
      this.warn('Redis increment failed', err);
      return this.redisIncrementFailure();
    }
  }

  private async incrSliding(key: string, maxOverride?: number): Promise<RateLimitResult> {
    const maxReq = sanitizeRateLimitCap(maxOverride ?? this.maxRequests, this.maxRequests);
    const now = Date.now();
    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    const rk = this.redisKey('sw', key);
    const raw = await this.evalScript(
      LUA_SLIDING_INCR,
      [rk],
      [now, this.windowMs, maxReq, member],
    );
    if (raw === null || !Array.isArray(raw) || raw.length < 3) {
      return this.redisIncrementFailure();
    }
    const count = Number(raw[0]);
    const blocked = Number(raw[1]) === 1;
    const resetMs = Number(raw[2]);
    if (Number.isNaN(count) || Number.isNaN(resetMs)) {
      return this.redisIncrementFailure();
    }
    const remaining = blocked ? 0 : Math.max(0, maxReq - count);
    return {
      totalHits: count,
      remaining,
      resetTime: new Date(resetMs),
      isBlocked: blocked,
    };
  }

  private async incrFixed(key: string, maxOverride?: number): Promise<RateLimitResult> {
    const maxReq = sanitizeRateLimitCap(maxOverride ?? this.maxRequests, this.maxRequests);
    const now = Date.now();
    const rk = this.redisKey('fw', key);
    const raw = await this.evalScript(LUA_FIXED_INCR, [rk], [this.windowMs, maxReq, now]);
    if (raw === null || !Array.isArray(raw) || raw.length < 3) {
      return this.redisIncrementFailure();
    }
    const current = Number(raw[0]);
    const blocked = Number(raw[1]) === 1;
    const resetMs = Number(raw[2]);
    if (Number.isNaN(current) || Number.isNaN(resetMs)) {
      return this.redisIncrementFailure();
    }
    const remaining = blocked ? 0 : Math.max(0, maxReq - current);
    return {
      totalHits: current,
      remaining,
      resetTime: new Date(resetMs),
      isBlocked: blocked,
    };
  }

  private async incrBucket(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const rk = this.redisKey('tb', key);
    const raw = await this.evalScript(
      LUA_BUCKET_INCR,
      [rk],
      [now, this.tokensPerInterval, this.refillIntervalMs, this.bucketSize],
    );
    if (raw === null || !Array.isArray(raw) || raw.length < 5) {
      return this.redisIncrementFailure();
    }
    const remaining = Number(raw[1]);
    const totalHits = Number(raw[2]);
    const blocked = Number(raw[3]) === 1;
    const nextMs = Number(raw[4]);
    if (Number.isNaN(remaining) || Number.isNaN(totalHits) || Number.isNaN(nextMs)) {
      return this.redisIncrementFailure();
    }
    return {
      totalHits,
      remaining,
      resetTime: new Date(nextMs),
      isBlocked: blocked,
    };
  }

  /** @inheritdoc */
  async decrement(key: string): Promise<void> {
    try {
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW: {
          const rk = this.redisKey('sw', key);
          const out = await this.evalScript(LUA_SLIDING_DECR, [rk], []);
          if (out === null) {
            this.warn('Redis decrement: EVAL returned no result');
            if (this.redisErrorMode === 'fail-closed') {
              this.warn('Redis decrement failed (fail-closed): counter state may drift');
            }
          }
          break;
        }
        case RateLimitStrategy.FIXED_WINDOW: {
          const rk = this.redisKey('fw', key);
          const out = await this.evalScript(LUA_FIXED_DECR, [rk], []);
          if (out === null) {
            this.warn('Redis decrement: EVAL returned no result');
            if (this.redisErrorMode === 'fail-closed') {
              this.warn('Redis decrement failed (fail-closed): counter state may drift');
            }
          }
          break;
        }
        case RateLimitStrategy.TOKEN_BUCKET: {
          const rk = this.redisKey('tb', key);
          const out = await this.evalScript(LUA_BUCKET_DECR, [rk], [this.bucketSize]);
          if (out === null) {
            this.warn('Redis decrement: EVAL returned no result');
            if (this.redisErrorMode === 'fail-closed') {
              this.warn('Redis decrement failed (fail-closed): counter state may drift');
            }
          }
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.warn('Redis decrement failed', err);
      if (this.redisErrorMode === 'fail-closed') {
        this.warn('Redis decrement threw (fail-closed mode)', err);
      }
    }
  }

  /** @inheritdoc */
  async reset(key: string): Promise<void> {
    try {
      const keys: string[] = [];
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW:
          keys.push(this.redisKey('sw', key));
          break;
        case RateLimitStrategy.FIXED_WINDOW:
          keys.push(this.redisKey('fw', key));
          break;
        case RateLimitStrategy.TOKEN_BUCKET:
          keys.push(this.redisKey('tb', key));
          break;
        default:
          break;
      }
      await this.delKeys(...keys);
    } catch (err) {
      this.warn('Redis reset failed', err);
      if (this.redisErrorMode === 'fail-closed') {
        throw err;
      }
    }
  }

  /** @inheritdoc */
  async shutdown(): Promise<void> {
    this.client = null;
    const owned = this.ownedRedis;
    this.ownedRedis = null;
    if (!owned) {
      return Promise.resolve();
    }
    try {
      if (typeof owned.quit === 'function') {
        await owned.quit();
      } else if (typeof owned.disconnect === 'function') {
        await owned.disconnect();
      }
    } catch (err) {
      this.warn('Redis shutdown (quit/disconnect) failed', err);
    }
    return Promise.resolve();
  }
}
