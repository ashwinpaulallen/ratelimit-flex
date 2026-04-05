import { randomBytes } from 'node:crypto';
import { CircuitBreaker } from '../resilience/CircuitBreaker.js';
import type { RedisResilienceOptions } from '../resilience/types.js';
import type { MemoryStore } from './memory-store.js';
import type {
  RateLimitDecrementOptions,
  RateLimitIncrementOptions,
  RateLimitResult,
  RateLimitStore,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { sanitizeIncrementCost, sanitizeRateLimitCap, sanitizeWindowMs } from '../utils/clamp.js';

/**
 * Strategy options for sliding or fixed window when using {@link RedisStore}.
 *
 * @since 1.0.0
 */
export type RedisStoreWindowOptions = {
  /** @description Must be {@link RateLimitStrategy.SLIDING_WINDOW} or {@link RateLimitStrategy.FIXED_WINDOW}. */
  strategy: RateLimitStrategy.SLIDING_WINDOW | RateLimitStrategy.FIXED_WINDOW;
  /**
   * @description Window length in milliseconds (sanitized in the constructor).
   */
  windowMs: number;
  /**
   * @description Max requests per window (sanitized in the constructor).
   */
  maxRequests: number;
};

/**
 * Strategy options for token bucket when using {@link RedisStore}.
 *
 * @since 1.0.0
 */
export type RedisStoreTokenBucketOptions = {
  /** @description Must be {@link RateLimitStrategy.TOKEN_BUCKET}. */
  strategy: RateLimitStrategy.TOKEN_BUCKET;
  /**
   * @description Tokens added per {@link RedisStoreTokenBucketOptions.interval}.
   */
  tokensPerInterval: number;
  /**
   * @description Refill interval in milliseconds.
   */
  interval: number;
  /**
   * @description Maximum tokens (burst capacity).
   */
  bucketSize: number;
};

/**
 * Discriminated union of Redis-backed strategy options (before connection fields).
 *
 * @since 1.0.0
 */
export type RedisStoreStrategyOptions = RedisStoreWindowOptions | RedisStoreTokenBucketOptions;

/**
 * Minimal Redis client surface used by {@link RedisStore}.
 *
 * @description Matches ioredis-style `eval(script, numKeys, ...keysAndArgs)` (keys first, then argv).
 * @see {@link adaptIoRedisClient}
 * @see {@link adaptNodeRedisClient}
 * @since 1.0.0
 */
export interface RedisLikeClient {
  /**
   * @description Redis GET (not used by all increment paths; available for adapters).
   * @param key - Redis key.
   */
  get(key: string): Promise<string | null | undefined>;
  /**
   * @description Redis SET (optional for some flows).
   */
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  /**
   * @description Lua `EVAL` / `EVALSHA` entry point (`eval(script, numKeys, ...keys, ...args)`).
   */
  eval(script: string, numKeys: number, ...keysAndArgs: string[]): Promise<unknown>;
  /**
   * @description Optional bulk delete for reset/shutdown paths.
   * @default undefined
   */
  del?: (...keys: string[]) => Promise<unknown>;
  /**
   * @description Optional graceful close (used when {@link RedisStore} owns a connection from `url`).
   * @default undefined
   */
  quit?: () => Promise<unknown>;
  /**
   * @description Optional disconnect.
   * @default undefined
   */
  disconnect?: () => void | Promise<void>;
}

/**
 * Behavior when Redis is unreachable or returns an error during quota operations.
 *
 * @description
 * - **`fail-open`** (default): allow traffic; log via {@link RedisStoreOptions.onWarn}.
 * - **`fail-closed`**: block with {@link RateLimitResult.storeUnavailable}; HTTP middleware returns **503**.
 * @see {@link RedisStore}
 * @since 1.0.0
 */
export type RedisErrorMode = 'fail-open' | 'fail-closed';

/**
 * Full options for {@link RedisStore}.
 *
 * @description Pass **either** `client` **or** `url`, not both.
 * @see {@link RedisStoreWindowOptions}
 * @see {@link RedisStoreTokenBucketOptions}
 * @since 1.0.0
 */
export type RedisStoreOptions = RedisStoreStrategyOptions & {
  /**
   * @description Existing Redis-compatible client (recommended for production).
   * @default undefined (use `url` or pass one of them)
   * @see {@link adaptIoRedisClient}
   * @see {@link adaptNodeRedisClient}
   */
  client?: RedisLikeClient;
  /**
   * @description Connection URL; dynamically loads optional peer `ioredis`.
   * @default undefined
   */
  url?: string;
  /**
   * @description Prefix for all keys written by this store.
   * @default `"rlf:"`
   */
  keyPrefix?: string;
  /**
   * @description Logger for Redis errors (connection, `EVAL`, `DEL`, etc.).
   * @default `console.warn` with a `[ratelimit-flex]` prefix
   */
  onWarn?: (message: string, error?: unknown) => void;
  /**
   * @description Policy when Redis cannot evaluate a limit (see {@link RedisErrorMode}). Ignored when `resilience.insuranceLimiter` is set — insurance replaces fail-open/fail-closed.
   * @default `'fail-open'`
   */
  onRedisError?: RedisErrorMode;
  /**
   * @description Optional insurance MemoryStore + circuit breaker around Redis. When set, failed Redis calls fall back to the in-memory store instead of {@link RedisStoreOptions.onRedisError}.
   * @since 1.3.2
   */
  resilience?: RedisResilienceOptions;
};

const DEFAULT_PREFIX = 'rlf:';

/**
 * Sliding window: ZSET prune + ZADD (cost entries) + ZCARD.
 * KEYS[1]=zset. ARGV: now, windowMs, maxRequests, cost, member1..memberN (each member must be unique within this ZADD batch).
 * Members are generated with crypto randomness in TS so concurrent calls cannot collide (unlike Math.random + suffix).
 */
const LUA_SLIDING_INCR = `
--rlf:si
local zkey = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local cost = tonumber(ARGV[4]) or 1
if cost < 1 then cost = 1 end

redis.call('ZREMRANGEBYSCORE', zkey, '-inf', now - window_ms)
for i = 1, cost do
  local m = ARGV[4 + i]
  if m == nil then
    return redis.error_reply('ratelimit-flex: sliding window missing member for slot ' .. i)
  end
  redis.call('ZADD', zkey, now, m)
end
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

/** Pop entries: ARGV[1]=cost, ARGV[2]='1' for newest (ZPOPMAX) else oldest (ZPOPMIN). */
const LUA_SLIDING_DECR = `
local n = tonumber(ARGV[1]) or 1
if n < 1 then n = 1 end
local newest = ARGV[2] == '1'
for i = 1, n do
  if newest then
    redis.call('ZPOPMAX', KEYS[1])
  else
    redis.call('ZPOPMIN', KEYS[1])
  end
end
return 1
`;

/** Fixed window: atomic INCRBY + PEXPIRE on first hit. KEYS[1]=counter, ARGV: windowMs, maxRequests, now, cost */
const LUA_FIXED_INCR = `
--rlf:fi
local k = KEYS[1]
local window_ms = tonumber(ARGV[1])
local max_requests = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4]) or 1
if cost < 1 then cost = 1 end

local current = tonumber(redis.call('INCRBY', k, cost))
if current == cost then
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
local dec = tonumber(ARGV[1]) or 1
if dec < 1 then dec = 1 end
local v = tonumber(redis.call('GET', k) or '0')
if v <= 0 then return v end
local take = math.min(v, dec)
redis.call('DECRBY', k, take)
return v
`;

/** Token bucket: HSET tokens + last_refill. KEYS[1]=hash, ARGV: now, tpi, interval_ms, bucket_size, cost */
const LUA_BUCKET_INCR = `
--rlf:bi
local key = KEYS[1]
local now = tonumber(ARGV[1])
local tokens_per_interval = tonumber(ARGV[2])
local interval_ms = tonumber(ARGV[3])
local bucket_size = tonumber(ARGV[4])
local cost = tonumber(ARGV[5]) or 1
if cost < 1 then cost = 1 end

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

if tokens >= cost then
  tokens = tokens - cost
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
local add = tonumber(ARGV[2]) or 1
if add < 1 then add = 1 end
local tokens_s = redis.call('HGET', key, 'tokens')
local tokens
if tokens_s == false then
  return 0
end
tokens = tonumber(tokens_s)
tokens = math.min(bucket_size, tokens + add)
redis.call('HSET', key, 'tokens', tostring(tokens))
return 1
`;

const LUA_DEL = `
return redis.call('DEL', unpack(KEYS))
`;

/** Sliding window: read-only ZCOUNT in window + oldest score (no ZREM). KEYS[1]=zset. ARGV: now, windowMs, maxRequests */
const LUA_SLIDING_GET = `
--rlf:sg
local zkey = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local min_open = '(' .. tostring(now - window_ms)
local count = tonumber(redis.call('ZCOUNT', zkey, min_open, '+inf')) or 0
if count == 0 then
  return nil
end
local blocked = 0
if count > max_requests then blocked = 1 end
local oldest_score = now
local r = redis.call('ZRANGE', zkey, 0, 0, 'WITHSCORES')
if r[2] ~= nil then
  oldest_score = tonumber(r[2])
end
local reset_at = oldest_score + window_ms
return { count, blocked, reset_at }
`;

/**
 * Sliding window: replace key state. KEYS[1]=zset. ARGV: now, windowMs, maxRequests, totalHits, expireArgMs,
 * member1..memberN (N = totalHits). If expireArgMs < 0, PEXPIRE(window_ms); else PEXPIREAT(expireArgMs).
 */
const LUA_SLIDING_SET = `
--rlf:ss
local zkey = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local total_hits = tonumber(ARGV[4])
if total_hits < 0 then total_hits = 0 end
local expire_arg = tonumber(ARGV[5])
redis.call('DEL', zkey)
for i = 1, total_hits do
  local m = ARGV[5 + i]
  if m == nil then
    return redis.error_reply('ratelimit-flex: sliding set missing member for slot ' .. i)
  end
  redis.call('ZADD', zkey, now, m)
end
if total_hits > 0 then
  if expire_arg < 0 then
    redis.call('PEXPIRE', zkey, window_ms)
  else
    redis.call('PEXPIREAT', zkey, expire_arg)
  end
end
local count = tonumber(redis.call('ZCARD', zkey)) or 0
if count == 0 then
  return { 0, 0, now + window_ms }
end
local blocked = 0
if count > max_requests then blocked = 1 end
local oldest_score = now
local r = redis.call('ZRANGE', zkey, 0, 0, 'WITHSCORES')
if r[2] ~= nil then
  oldest_score = tonumber(r[2])
end
local reset_at = oldest_score + window_ms
return { count, blocked, reset_at }
`;

/** Fixed window: read-only GET + PTTL. KEYS[1]=counter. ARGV: windowMs, maxRequests, now */
const LUA_FIXED_GET = `
--rlf:fg
local k = KEYS[1]
local window_ms = tonumber(ARGV[1])
local max_requests = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local s = redis.call('GET', k)
if s == false then
  return nil
end
local current = tonumber(s)
local pttl = tonumber(redis.call('PTTL', k))
if pttl < 0 then pttl = window_ms end
local reset_at = now + pttl
local blocked = 0
if current > max_requests then blocked = 1 end
return { current, blocked, reset_at }
`;

/** Token bucket: read-only refill + snapshot. KEYS[1]=hash. ARGV: now, tpi, interval_ms, bucket_size */
const LUA_BUCKET_GET = `
--rlf:bg
local key = KEYS[1]
local now = tonumber(ARGV[1])
local tokens_per_interval = tonumber(ARGV[2])
local interval_ms = tonumber(ARGV[3])
local bucket_size = tonumber(ARGV[4])

local tokens_s = redis.call('HGET', key, 'tokens')
local last_s = redis.call('HGET', key, 'last_refill')
if tokens_s == false or last_s == false then
  return nil
end

local tokens = tonumber(tokens_s)
local last_refill = tonumber(last_s)

local elapsed = now - last_refill
local intervals = math.floor(elapsed / interval_ms)
if intervals > 0 then
  tokens = math.min(bucket_size, tokens + intervals * tokens_per_interval)
  last_refill = last_refill + intervals * interval_ms
end

local remaining = tokens
local total_hits = bucket_size - remaining
local blocked = 0
if remaining == 0 and total_hits >= bucket_size then
  blocked = 1
end
local next_tick = last_refill + interval_ms
return { remaining, total_hits, blocked, next_tick }
`;

/** Sync token-bucket hash after insurance recovery. KEYS[1]=hash, ARGV: tokens, last_refill, interval_ms */
const LUA_BUCKET_SYNC = `
--rlf:bs
local key = KEYS[1]
local tokens = tonumber(ARGV[1])
local last_refill = tonumber(ARGV[2])
local interval_ms = tonumber(ARGV[3])
redis.call('HSET', key, 'tokens', tostring(tokens), 'last_refill', tostring(last_refill))
redis.call('PEXPIRE', key, interval_ms * 10)
return 1
`;

/**
 * Adapts an **ioredis**-style client to {@link RedisLikeClient}.
 *
 * @description Coerces `eval` arguments to strings for compatibility with {@link RedisStore}.
 * @param client - ioredis instance with `get`, `set`, `eval`, optional `del` / `quit` / `disconnect`.
 * @returns A {@link RedisLikeClient} wrapper.
 * @example
 * ```ts
 * import Redis from 'ioredis';
 * const store = new RedisStore({
 *   strategy: RateLimitStrategy.SLIDING_WINDOW,
 *   windowMs: 60_000,
 *   maxRequests: 100,
 *   client: adaptIoRedisClient(new Redis(process.env.REDIS_URL!)),
 * });
 * ```
 * @since 1.0.0
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
 * Adapts **node-redis** v4+ clients (`eval(script, { keys, arguments })`) to {@link RedisLikeClient}.
 *
 * @description Does not add a `redis` package dependency — pass your connected client.
 * @param client - node-redis client with `get`, `set`, `eval`, optional `del` / `quit` / `disconnect`.
 * @returns A {@link RedisLikeClient} wrapper.
 * @example
 * ```ts
 * import { createClient } from 'redis';
 * const raw = createClient({ url: process.env.REDIS_URL });
 * await raw.connect();
 * const store = new RedisStore({
 *   strategy: RateLimitStrategy.SLIDING_WINDOW,
 *   windowMs: 60_000,
 *   maxRequests: 100,
 *   client: adaptNodeRedisClient(raw),
 * });
 * ```
 * @since 1.0.0
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
 * Redis-backed {@link RateLimitStore} using Lua scripts for atomic increments.
 *
 * @description Shares counters across nodes; use when multiple processes must enforce one global limit.
 * Supports {@link RateLimitIncrementOptions.cost} on all strategies; sliding window uses unique ZSET members per unit (crypto randomness from Node) so `ZADD` never merges distinct hits.
 * Pass either `client` (recommended) or `url` (loads optional peer `ioredis` at runtime).
 * @see {@link MemoryStore} — single-process alternative
 * @see {@link RedisErrorMode}
 * @since 1.0.0
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

  private readonly resilience?: RedisResilienceOptions;

  private readonly insuranceStore: MemoryStore | null = null;

  private readonly circuitBreaker: CircuitBreaker | null = null;

  /** Set when consecutive Redis failures first open the circuit (for recovery downtime). */
  private failoverStartedAtMs: number | null = null;

  /**
   * @description Validates connection options, normalizes caps/window, and prepares the Redis client (or `ioredis` import from `url`).
   * @param options - Strategy fields plus `client` or `url`, optional `keyPrefix`, `onWarn`, `onRedisError`.
   * @example
   * ```ts
   * const store = new RedisStore({
   *   strategy: RateLimitStrategy.SLIDING_WINDOW,
   *   windowMs: 60_000,
   *   maxRequests: 100,
   *   url: 'redis://127.0.0.1:6379',
   *   onRedisError: 'fail-open',
   * });
   * ```
   * @throws If both `url` and `client` are set, or neither is set.
   * @throws If `url` is used and `ioredis` fails to load (dynamic import error).
   * @see {@link RedisStore.shutdown}
   * @since 1.0.0
   */
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

    this.resilience = options.resilience;
    if (options.resilience?.insuranceLimiter) {
      const hooks = options.resilience.hooks;
      const userCb = options.resilience.circuitBreaker;
      this.insuranceStore = options.resilience.insuranceLimiter.store;
      this.circuitBreaker = new CircuitBreaker({
        failureThreshold: userCb?.failureThreshold ?? 3,
        recoveryTimeMs: userCb?.recoveryTimeMs ?? 5000,
        halfOpenMaxProbes: userCb?.halfOpenMaxProbes ?? 1,
        onOpen: () => {
          hooks?.onCircuitOpen?.();
          userCb?.onOpen?.();
        },
        onClose: () => {
          hooks?.onCircuitClose?.();
          const t0 = this.failoverStartedAtMs;
          const downtime = t0 !== null ? Date.now() - t0 : 0;
          this.failoverStartedAtMs = null;
          hooks?.onRecovery?.(downtime);
          void this.syncCountersToRedis();
          userCb?.onClose?.();
        },
        onHalfOpen: () => {
          userCb?.onHalfOpen?.();
        },
      });
    }
  }

  /**
   * @description `true` when {@link RedisStoreOptions.resilience.insuranceLimiter} was configured.
   * @since 1.3.2
   */
  hasInsuranceLimiter(): boolean {
    return this.insuranceStore !== null;
  }

  private usesInsurance(): boolean {
    return this.insuranceStore !== null && this.circuitBreaker !== null;
  }

  /**
   * @description When {@link CircuitBreaker.canAttempt} is false, quota ops must use the insurance store — same routing as {@link RedisStore.incrementWithResilience} (covers OPEN and HALF_OPEN when probes are exhausted).
   */
  private shouldRouteQuotaViaInsurance(): boolean {
    return this.usesInsurance() && !this.circuitBreaker!.canAttempt();
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

  /**
   * @inheritdoc
   * @param key - Client identifier (same key namespace as {@link MemoryStore}).
   * @param options - Optional **`maxRequests`** (sliding/fixed) and **`cost`** (all strategies; default `1`).
   * @returns Promise resolving to {@link RateLimitResult}; may return fail-open or fail-closed shape when Redis errors.
   * @description Catches Redis errors and applies {@link RedisErrorMode} via {@link RedisStoreOptions.onRedisError}.
   */
  async increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult> {
    if (this.usesInsurance()) {
      return this.incrementWithResilience(key, options);
    }
    const maxOverride = options?.maxRequests;
    const cost = sanitizeIncrementCost(options?.cost, 1);
    try {
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW: {
          const r = await this.incrSlidingRedis(key, maxOverride, cost);
          if (r === null) {
            return this.redisIncrementFailure();
          }
          return r;
        }
        case RateLimitStrategy.FIXED_WINDOW: {
          const r = await this.incrFixedRedis(key, maxOverride, cost);
          if (r === null) {
            return this.redisIncrementFailure();
          }
          return r;
        }
        case RateLimitStrategy.TOKEN_BUCKET: {
          const r = await this.incrBucketRedis(key, cost);
          if (r === null) {
            return this.redisIncrementFailure();
          }
          return r;
        }
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

  private async incrementWithResilience(
    key: string,
    options?: RateLimitIncrementOptions,
  ): Promise<RateLimitResult> {
    const maxOverride = options?.maxRequests;
    const cost = sanitizeIncrementCost(options?.cost, 1);
    const cb = this.circuitBreaker!;

    if (this.shouldRouteQuotaViaInsurance()) {
      return this.insuranceIncrement(key, options);
    }

    let result: RateLimitResult | null;
    try {
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW:
          result = await this.incrSlidingRedis(key, maxOverride, cost);
          break;
        case RateLimitStrategy.FIXED_WINDOW:
          result = await this.incrFixedRedis(key, maxOverride, cost);
          break;
        case RateLimitStrategy.TOKEN_BUCKET:
          result = await this.incrBucketRedis(key, cost);
          break;
        default: {
          const _: never = this.strategy;
          return Promise.reject(new Error(`Unsupported strategy: ${String(_)}`));
        }
      }
    } catch (err) {
      this.warn('Redis increment failed', err);
      return this.handleRedisFailureForIncrement(key, options, err);
    }

    if (result !== null) {
      cb.recordSuccess();
      return result;
    }

    return this.handleRedisFailureForIncrement(
      key,
      options,
      new Error('Redis operation returned no result'),
    );
  }

  private async insuranceIncrement(
    key: string,
    options?: RateLimitIncrementOptions,
  ): Promise<RateLimitResult> {
    const r = await this.insuranceStore!.increment(key, options);
    this.resilience?.hooks?.onInsuranceHit?.(key);
    return { ...r, storeUnavailable: true };
  }

  private handleRedisFailureForIncrement(
    key: string,
    options: RateLimitIncrementOptions | undefined,
    err: unknown,
  ): Promise<RateLimitResult> {
    const error = err instanceof Error ? err : new Error(String(err));
    const cb = this.circuitBreaker!;
    const before = cb.state;
    cb.recordFailure();
    // onFailover only when the circuit first opens from CLOSED (threshold reached). A failed HALF_OPEN
    // probe re-opens the circuit without onFailover — failover was already signaled.
    if (before === 'CLOSED' && cb.state === 'OPEN') {
      this.failoverStartedAtMs = Date.now();
      this.resilience?.hooks?.onFailover?.(error);
    }
    return this.insuranceIncrement(key, options);
  }

  /**
   * Pushes insurance {@link MemoryStore.getActiveKeys} into Redis after the circuit closes, then {@link MemoryStore.resetAll}.
   *
   * @description **Sliding window:** Replays `totalHits` through the same Lua as live increments; synthetic members all use score **`now`**, so the count is correct but timestamps are not spread across the original window — the effective window restarts from recovery (burst “resets” at sync time). **Fixed window:** One increment with **`totalHits`** as cost. **Token bucket:** Direct bucket sync script (tokens + last refill), not increment Lua. No-ops when **`syncOnRecovery`** is **`false`** (early return before iteration).
   */
  private async syncCountersToRedis(): Promise<void> {
    if (!this.usesInsurance() || !this.insuranceStore) {
      return;
    }
    if (this.resilience?.insuranceLimiter?.syncOnRecovery === false) {
      return;
    }

    const hooks = this.resilience?.hooks;
    let keysSynced = 0;
    let errors = 0;

    try {
      const active = this.insuranceStore.getActiveKeys();
      const now = Date.now();
      for (const [key, entry] of active.entries()) {
        try {
          await this.syncOneKeyToRedis(key, entry, now);
          keysSynced++;
        } catch {
          errors++;
        }
      }
      this.insuranceStore.resetAll();
      hooks?.onCounterSync?.(keysSynced, errors);
    } catch (err) {
      this.warn('Redis resilience: counter sync failed', err);
    }
  }

  /** @see {@link RedisStore.syncCountersToRedis} for sliding-window timestamp semantics at recovery. */
  private async syncOneKeyToRedis(
    key: string,
    entry: { totalHits: number; resetTime: Date },
    now: number,
  ): Promise<void> {
    const maxReq = this.maxRequests;
    switch (this.strategy) {
      case RateLimitStrategy.SLIDING_WINDOW: {
        const cost = entry.totalHits;
        if (cost <= 0) {
          return;
        }
        // Members all scored at `now` — restores ZCARD; does not reconstruct spread timestamps from MemoryStore.
        const members = Array.from({ length: cost }, () => randomBytes(16).toString('hex'));
        const rk = this.redisKey('sw', key);
        const raw = await this.evalScript(LUA_SLIDING_INCR, [rk], [
          now,
          this.windowMs,
          maxReq,
          cost,
          ...members,
        ]);
        if (raw === null) {
          throw new Error('sync sliding failed');
        }
        return;
      }
      case RateLimitStrategy.FIXED_WINDOW: {
        const rk = this.redisKey('fw', key);
        const raw = await this.evalScript(LUA_FIXED_INCR, [rk], [
          this.windowMs,
          maxReq,
          now,
          entry.totalHits,
        ]);
        if (raw === null) {
          throw new Error('sync fixed failed');
        }
        return;
      }
      case RateLimitStrategy.TOKEN_BUCKET: {
        const remaining = Math.max(0, this.bucketSize - entry.totalHits);
        const lastRefill = entry.resetTime.getTime() - this.refillIntervalMs;
        const rk = this.redisKey('tb', key);
        const raw = await this.evalScript(LUA_BUCKET_SYNC, [rk], [
          remaining,
          lastRefill,
          this.refillIntervalMs,
        ]);
        if (raw === null) {
          throw new Error('sync token bucket failed');
        }
        return;
      }
      default: {
        const exhaustive: never = this.strategy;
        throw new Error(`Unsupported strategy: ${String(exhaustive)}`);
      }
    }
  }

  private async incrSlidingRedis(
    key: string,
    maxOverride?: number,
    cost = 1,
  ): Promise<RateLimitResult | null> {
    const maxReq = sanitizeRateLimitCap(maxOverride ?? this.maxRequests, this.maxRequests);
    const now = Date.now();
    const members = Array.from({ length: cost }, () => randomBytes(16).toString('hex'));
    const rk = this.redisKey('sw', key);
    const raw = await this.evalScript(LUA_SLIDING_INCR, [rk], [
      now,
      this.windowMs,
      maxReq,
      cost,
      ...members,
    ]);
    if (raw === null || !Array.isArray(raw) || raw.length < 3) {
      return null;
    }
    const count = Number(raw[0]);
    const blocked = Number(raw[1]) === 1;
    const resetMs = Number(raw[2]);
    if (Number.isNaN(count) || Number.isNaN(resetMs)) {
      return null;
    }
    const remaining = blocked ? 0 : Math.max(0, maxReq - count);
    return {
      totalHits: count,
      remaining,
      resetTime: new Date(resetMs),
      isBlocked: blocked,
    };
  }

  private async incrFixedRedis(
    key: string,
    maxOverride?: number,
    cost = 1,
  ): Promise<RateLimitResult | null> {
    const maxReq = sanitizeRateLimitCap(maxOverride ?? this.maxRequests, this.maxRequests);
    const now = Date.now();
    const rk = this.redisKey('fw', key);
    const raw = await this.evalScript(LUA_FIXED_INCR, [rk], [this.windowMs, maxReq, now, cost]);
    if (raw === null || !Array.isArray(raw) || raw.length < 3) {
      return null;
    }
    const current = Number(raw[0]);
    const blocked = Number(raw[1]) === 1;
    const resetMs = Number(raw[2]);
    if (Number.isNaN(current) || Number.isNaN(resetMs)) {
      return null;
    }
    const remaining = blocked ? 0 : Math.max(0, maxReq - current);
    return {
      totalHits: current,
      remaining,
      resetTime: new Date(resetMs),
      isBlocked: blocked,
    };
  }

  private async incrBucketRedis(key: string, cost = 1): Promise<RateLimitResult | null> {
    const now = Date.now();
    const rk = this.redisKey('tb', key);
    const raw = await this.evalScript(
      LUA_BUCKET_INCR,
      [rk],
      [now, this.tokensPerInterval, this.refillIntervalMs, this.bucketSize, cost],
    );
    if (raw === null || !Array.isArray(raw) || raw.length < 5) {
      return null;
    }
    const remaining = Number(raw[1]);
    const totalHits = Number(raw[2]);
    const blocked = Number(raw[3]) === 1;
    const nextMs = Number(raw[4]);
    if (Number.isNaN(remaining) || Number.isNaN(totalHits) || Number.isNaN(nextMs)) {
      return null;
    }
    return {
      totalHits,
      remaining,
      resetTime: new Date(nextMs),
      isBlocked: blocked,
    };
  }

  /**
   * @inheritdoc
   * @param key - Same key passed to {@link RedisStore.increment}.
   * @param options - Optional **`cost`** to match the prior increment (default `1`).
   * @description Swallows most errors; in `fail-closed` mode may log extra warnings if `EVAL` fails.
   */
  async decrement(key: string, options?: RateLimitDecrementOptions): Promise<void> {
    const cost = sanitizeIncrementCost(options?.cost, 1);
    if (this.shouldRouteQuotaViaInsurance()) {
      await this.insuranceStore!.decrement(key, options);
      return;
    }
    try {
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW: {
          const rk = this.redisKey('sw', key);
          const out = await this.evalScript(LUA_SLIDING_DECR, [rk], [
            String(cost),
            options?.removeNewest === true ? '1' : '0',
          ]);
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
          const out = await this.evalScript(LUA_FIXED_DECR, [rk], [cost]);
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
          const out = await this.evalScript(LUA_BUCKET_DECR, [rk], [this.bucketSize, cost]);
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

  /**
   * @inheritdoc
   * @param key - Key whose Redis keys should be deleted.
   * @throws In `fail-closed` mode if Redis cannot delete keys.
   */
  async reset(key: string): Promise<void> {
    if (this.shouldRouteQuotaViaInsurance()) {
      await this.insuranceStore!.reset(key);
      return;
    }
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

  /**
   * @inheritdoc
   * @description Read-only quota snapshot; does not mutate Redis keys (sliding window does not prune expired ZSET members).
   */
  async get(key: string): Promise<{
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  } | null> {
    if (this.shouldRouteQuotaViaInsurance()) {
      return this.insuranceStore!.get!(key);
    }
    try {
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW:
          return await this.getSlidingRedis(key);
        case RateLimitStrategy.FIXED_WINDOW:
          return await this.getFixedRedis(key);
        case RateLimitStrategy.TOKEN_BUCKET:
          return await this.getBucketRedis(key);
        default: {
          const _: never = this.strategy;
          return Promise.reject(new Error(`Unsupported strategy: ${String(_)}`));
        }
      }
    } catch (err) {
      this.warn('Redis get failed', err);
      return null;
    }
  }

  /**
   * @inheritdoc
   */
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
    if (this.shouldRouteQuotaViaInsurance()) {
      return this.insuranceStore!.set!(key, totalHits, expiresAt);
    }
    try {
      let r: RateLimitResult | null = null;
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW:
          r = await this.setSlidingRedis(key, totalHits, expiresAt);
          break;
        case RateLimitStrategy.FIXED_WINDOW:
          r = await this.setFixedRedis(key, totalHits, expiresAt);
          break;
        case RateLimitStrategy.TOKEN_BUCKET:
          r = await this.setBucketRedis(key, totalHits);
          break;
        default: {
          const _: never = this.strategy;
          return Promise.reject(new Error(`Unsupported strategy: ${String(_)}`));
        }
      }
      if (r === null) {
        return this.redisIncrementFailure();
      }
      return r;
    } catch (err) {
      this.warn('Redis set failed', err);
      return this.redisIncrementFailure();
    }
  }

  /**
   * @inheritdoc
   */
  async delete(key: string): Promise<boolean> {
    if (this.shouldRouteQuotaViaInsurance()) {
      const d = this.insuranceStore!.delete;
      return d !== undefined ? d.call(this.insuranceStore, key) : false;
    }
    try {
      let rk = '';
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW:
          rk = this.redisKey('sw', key);
          break;
        case RateLimitStrategy.FIXED_WINDOW:
          rk = this.redisKey('fw', key);
          break;
        case RateLimitStrategy.TOKEN_BUCKET:
          rk = this.redisKey('tb', key);
          break;
        default:
          return false;
      }
      return await this.deleteOneRedisKey(rk);
    } catch (err) {
      this.warn('Redis delete failed', err);
      if (this.redisErrorMode === 'fail-closed') {
        throw err;
      }
      return false;
    }
  }

  private async getSlidingRedis(key: string): Promise<RateLimitResult | null> {
    const maxReq = sanitizeRateLimitCap(this.maxRequests, this.maxRequests);
    const now = Date.now();
    const rk = this.redisKey('sw', key);
    const raw = await this.evalScript(LUA_SLIDING_GET, [rk], [now, this.windowMs, maxReq]);
    if (raw === null || raw === false) {
      return null;
    }
    if (!Array.isArray(raw) || raw.length < 3) {
      return null;
    }
    const count = Number(raw[0]);
    const blocked = Number(raw[1]) === 1;
    const resetMs = Number(raw[2]);
    if (Number.isNaN(count) || Number.isNaN(resetMs)) {
      return null;
    }
    if (count === 0) {
      return null;
    }
    const remaining = blocked ? 0 : Math.max(0, maxReq - count);
    return {
      totalHits: count,
      remaining,
      resetTime: new Date(resetMs),
      isBlocked: blocked,
    };
  }

  private async getFixedRedis(key: string): Promise<RateLimitResult | null> {
    const maxReq = sanitizeRateLimitCap(this.maxRequests, this.maxRequests);
    const now = Date.now();
    const rk = this.redisKey('fw', key);
    const raw = await this.evalScript(LUA_FIXED_GET, [rk], [this.windowMs, maxReq, now]);
    if (raw === null || raw === false) {
      return null;
    }
    if (!Array.isArray(raw) || raw.length < 3) {
      return null;
    }
    const current = Number(raw[0]);
    const blocked = Number(raw[1]) === 1;
    const resetMs = Number(raw[2]);
    if (Number.isNaN(current) || Number.isNaN(resetMs)) {
      return null;
    }
    const remaining = blocked ? 0 : Math.max(0, maxReq - current);
    return {
      totalHits: current,
      remaining,
      resetTime: new Date(resetMs),
      isBlocked: blocked,
    };
  }

  private async getBucketRedis(key: string): Promise<RateLimitResult | null> {
    const now = Date.now();
    const rk = this.redisKey('tb', key);
    const raw = await this.evalScript(LUA_BUCKET_GET, [rk], [
      now,
      this.tokensPerInterval,
      this.refillIntervalMs,
      this.bucketSize,
    ]);
    if (raw === null || raw === false) {
      return null;
    }
    if (!Array.isArray(raw) || raw.length < 4) {
      return null;
    }
    const remaining = Number(raw[0]);
    const totalHits = Number(raw[1]);
    const blocked = Number(raw[2]) === 1;
    const nextMs = Number(raw[3]);
    if (Number.isNaN(remaining) || Number.isNaN(totalHits) || Number.isNaN(nextMs)) {
      return null;
    }
    return {
      totalHits,
      remaining,
      resetTime: new Date(nextMs),
      isBlocked: blocked,
    };
  }

  private async setSlidingRedis(
    key: string,
    totalHits: number,
    expiresAt?: Date,
  ): Promise<RateLimitResult | null> {
    const maxReq = sanitizeRateLimitCap(this.maxRequests, this.maxRequests);
    const now = Date.now();
    const n = Math.max(0, Math.floor(totalHits));
    const rk = this.redisKey('sw', key);
    const expireArg = expiresAt !== undefined ? expiresAt.getTime() : -1;
    const members = Array.from({ length: n }, () => randomBytes(16).toString('hex'));
    const raw = await this.evalScript(LUA_SLIDING_SET, [rk], [
      now,
      this.windowMs,
      maxReq,
      n,
      expireArg,
      ...members,
    ]);
    if (raw === null || !Array.isArray(raw) || raw.length < 3) {
      return null;
    }
    const count = Number(raw[0]);
    const blocked = Number(raw[1]) === 1;
    const resetMs = Number(raw[2]);
    if (Number.isNaN(count) || Number.isNaN(resetMs)) {
      return null;
    }
    const remaining = blocked ? 0 : Math.max(0, maxReq - count);
    return {
      totalHits: count,
      remaining,
      resetTime: new Date(resetMs),
      isBlocked: blocked,
    };
  }

  private async setFixedRedis(
    key: string,
    totalHits: number,
    expiresAt?: Date,
  ): Promise<RateLimitResult | null> {
    const r = await this.getClient();
    if (r === null) {
      return null;
    }
    const n = Math.max(0, Math.floor(totalHits));
    const rk = this.redisKey('fw', key);
    try {
      if (expiresAt !== undefined) {
        await r.set(rk, String(n), 'PXAT', String(expiresAt.getTime()));
      } else {
        await r.set(rk, String(n), 'PX', String(this.windowMs));
      }
    } catch (err) {
      this.warn('Redis SET (fixed set) failed', err);
      return null;
    }
    return this.getFixedRedis(key);
  }

  private async setBucketRedis(key: string, totalHits: number): Promise<RateLimitResult | null> {
    const cap = this.bucketSize;
    const th = Math.max(0, totalHits);
    const isBlocked = th >= cap;
    const tokens = isBlocked ? 0 : Math.max(0, cap - th);
    const lastRefill = Date.now();
    const rk = this.redisKey('tb', key);
    const raw = await this.evalScript(LUA_BUCKET_SYNC, [rk], [
      tokens,
      lastRefill,
      this.refillIntervalMs,
    ]);
    if (raw === null) {
      return null;
    }
    const totalHitsOut = isBlocked ? cap : th;
    return {
      totalHits: totalHitsOut,
      remaining: tokens,
      resetTime: new Date(lastRefill + this.refillIntervalMs),
      isBlocked,
    };
  }

  private async deleteOneRedisKey(rk: string): Promise<boolean> {
    try {
      const r = await this.getClient();
      if (r === null) {
        this.warn('Redis client unavailable (DEL)');
        if (this.redisErrorMode === 'fail-closed') {
          throw new Error('Redis client unavailable');
        }
        return false;
      }
      if (r.del) {
        const out = await r.del(rk);
        return Number(out) >= 1;
      }
      const out = await r.eval('return redis.call("DEL", KEYS[1])', 1, rk);
      return Number(out) === 1;
    } catch (err) {
      this.warn('Redis DEL failed', err);
      if (this.redisErrorMode === 'fail-closed') {
        throw err;
      }
      return false;
    }
  }

  /**
   * @inheritdoc
   * @description Clears the client reference and calls `quit` / `disconnect` on a connection created from `url`.
   */
  async shutdown(): Promise<void> {
    this.circuitBreaker?.destroy();
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
