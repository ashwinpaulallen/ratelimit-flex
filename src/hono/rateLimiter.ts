import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  formatRateLimitHeaders,
  type HeaderFormat,
  type HeaderInput,
  resolveHeaderConfig,
} from '../headers/index.js';
import {
  jsonErrorBody,
  keyManagerBlockedJson,
  keyManagerRetryAfterSeconds,
  mergeRateLimiterOptions,
  resolveStoreWithInMemoryShield,
  toRateLimitInfo,
} from '../middleware/merge-options.js';
import { RateLimitEngine } from '../strategies/rate-limit-engine.js';
import type { InMemoryShieldOptions } from '../shield/types.js';
import type {
  RateLimitConsumeResult,
  RateLimitInfo,
  RateLimitOptions,
  RateLimitStore,
  RateLimitStrategy,
} from '../types/index.js';
import type { StandardHeadersDraft } from '../types/index.js';
import { warnIfMemoryStoreInCluster, warnIfRedisStoreWithoutInsurance } from '../utils/environment.js';
import { MetricsManager } from '../metrics/manager.js';
import type { MetricsSnapshot } from '../types/metrics.js';

/** Internal context key for per-request weighted cost (see {@link HonoRateLimitOptions.cost}). */
export const HONO_RATE_LIMIT_INCREMENT_COST = 'ratelimitFlex:incrementCost' as const;

/**
 * Helper to cast numeric status codes to Hono's ContentfulStatusCode type.
 * @internal
 */
function toContentfulStatus(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

declare module 'hono' {
  interface ContextVariableMap {
    /** Last {@link RateLimitEngine.consumeWithKey} result (set on allow). */
    rateLimitResult?: RateLimitConsumeResult;
    /** Snapshot for downstream handlers (same idea as Express `req.rateLimit`). */
    rateLimit?: RateLimitInfo;
    /** @internal Per-request cost for {@link HonoRateLimitOptions.cost}. */
    'ratelimitFlex:incrementCost'?: number;
  }
}

/**
 * Hono rate limiter options.
 *
 * @remarks
 * **Limitation:** `skipFailedRequests` and `skipSuccessfulRequests` (available in Express/Fastify adapters)
 * are not supported in the Hono adapter due to Hono's lack of built-in response lifecycle hooks. Hono does
 * not provide a stable `onResponse` hook equivalent to Express/Fastify, making it impossible to decrement
 * counters based on response status codes without significant complexity or relying on experimental features.
 */
export interface HonoRateLimitOptions {
  /** Max requests per window */
  maxRequests?: number;
  /** Window duration in ms */
  windowMs?: number;
  /** Rate limiting strategy */
  strategy?: RateLimitStrategy;
  /** Backing store. Default: in-memory when omitted (not suitable for multi-instance without Redis, etc.). */
  store?: RateLimitStore;

  /**
   * Key generator. Receives the Hono {@link Context}.
   *
   * @remarks
   * Default uses `x-forwarded-for` / `x-real-ip`. On edge runtimes, IP may be missing unless the platform
   * sets these headers — prefer an explicit key (API key, session id) in production.
   */
  keyGenerator?: (c: Context) => string | Promise<string>;

  /** Standard headers profile (draft RFC or legacy `X-RateLimit-*`). */
  standardHeaders?: StandardHeadersDraft | boolean;
  /** When using a draft profile, also emit legacy `X-RateLimit-*`. */
  legacyHeaders?: boolean;

  /** Status code when rate limited (default: 429) */
  statusCode?: number;
  /** Response body when rate limited (not used when `message` is a function returning a `Response`). */
  message?: string | object | ((c: Context) => Response | Promise<Response>);

  /** Cost per request (weighted limiting). Async functions are supported. */
  cost?: number | ((c: Context) => number | Promise<number>);

  /** Skip rate limiting for this request (async supported). */
  skip?: (c: Context) => boolean | Promise<boolean>;

  /** Allowlist of keys that bypass rate limiting */
  allowlist?: readonly string[];
  /** Blocklist of keys that are always rejected */
  blocklist?: readonly string[];

  /** Identifier for draft standard headers */
  identifier?: string;

  /** Wrap remote store with {@link InMemoryShield} (same semantics as other adapters). */
  inMemoryBlock?: number | boolean | InMemoryShieldOptions;

  /** Called when a request is blocked by the **rate limit** (not blocklist / 503). After this runs, the middleware sends the JSON error unless `message` is a function that returns a `Response`. */
  onLimitReached?: (c: Context, key: string) => void | Promise<void>;
}

export function honoDefaultKeyGenerator(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
}

function honoOptionsToRateLimitPartial(h: HonoRateLimitOptions): Partial<RateLimitOptions> {
  const messageForMerge =
    h.message !== undefined && typeof h.message !== 'function' ? h.message : undefined;

  return {
    maxRequests: h.maxRequests,
    windowMs: h.windowMs,
    strategy: h.strategy,
    store: h.store,
    standardHeaders: h.standardHeaders,
    legacyHeaders: h.legacyHeaders,
    statusCode: h.statusCode,
    message: messageForMerge,
    allowlist: h.allowlist,
    blocklist: h.blocklist,
    identifier: h.identifier,
    inMemoryBlock: h.inMemoryBlock,
    incrementCost: (req: unknown) => {
      const ctx = req as Context;
      const v = ctx.get(HONO_RATE_LIMIT_INCREMENT_COST);
      if (typeof v === 'number' && Number.isFinite(v)) {
        return v;
      }
      return 1;
    },
  };
}

async function resolveRequestCost(c: Context, h: HonoRateLimitOptions): Promise<number> {
  if (h.cost === undefined) {
    return 1;
  }
  if (typeof h.cost === 'number') {
    return h.cost;
  }
  return await Promise.resolve(h.cost(c));
}

function applyHeadersToContext(c: Context, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    c.header(name, value);
  }
}

/**
 * Extended middleware handler with metrics support.
 */
export interface HonoRateLimiterHandler extends MiddlewareHandler {
  /** Metrics manager instance (no-op when metrics disabled). */
  metricsManager: MetricsManager;
  /** Get current metrics snapshot. */
  getMetricsSnapshot(): MetricsSnapshot | null;
  /** Get metrics history. */
  getMetricsHistory(): MetricsSnapshot[];
  /** Shutdown the metrics manager and cleanup resources. */
  shutdown(): Promise<void>;
}

/**
 * Rate limiting middleware for Hono (uses {@link RateLimitEngine} — same core as Express / Fastify).
 *
 * @remarks
 * The returned handler includes a `metricsManager` property for observability. Call `handler.shutdown()`
 * when the app is shutting down to cleanup metrics resources.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono';
 * import { rateLimiter } from 'ratelimit-flex/hono';
 *
 * const app = new Hono();
 * const limiter = rateLimiter({ maxRequests: 100, windowMs: 60_000 });
 * app.use('*', limiter);
 *
 * // With metrics
 * const limiterWithMetrics = rateLimiter({
 *   maxRequests: 100,
 *   windowMs: 60_000,
 *   metrics: { enabled: true, snapshotIntervalMs: 10_000 }
 * });
 * app.use('*', limiterWithMetrics);
 *
 * // Later: cleanup
 * await limiterWithMetrics.shutdown();
 * ```
 */
export function rateLimiter(options: HonoRateLimitOptions = {}): HonoRateLimiterHandler {
  const merged = mergeRateLimiterOptions(honoOptionsToRateLimitPartial(options));
  const { optionsForEngine: resolved, shield } = resolveStoreWithInMemoryShield(merged);
  warnIfMemoryStoreInCluster(resolved.store);
  warnIfRedisStoreWithoutInsurance(resolved.store);

  const metricsManager = new MetricsManager(resolved.metrics, shield);
  const { onLimitReached: _engineOnLimit, ...engineOptions } = resolved;
  void _engineOnLimit;
  const engine = new RateLimitEngine(engineOptions, metricsManager.getCounters() ?? undefined);

  const keyFromContext = options.keyGenerator ?? honoDefaultKeyGenerator;
  let metricsCollectorStarted = false;

  const middleware: MiddlewareHandler = async (c, next) => {
    try {
      if (!metricsCollectorStarted && metricsManager.getCounters()) {
        metricsManager.start();
        metricsCollectorStarted = true;
      }

      if (options.skip !== undefined) {
        const s = await Promise.resolve(options.skip(c));
        if (s === true) {
          return next();
        }
      }

      const key = await Promise.resolve(keyFromContext(c));

      c.set(HONO_RATE_LIMIT_INCREMENT_COST, await resolveRequestCost(c, options));

      const result = await engine.consumeWithKey(key, c);

    if (result.storeUnavailable === true) {
      c.header('X-RateLimit-Store', 'fallback');
    }

    const headerCfg = resolveHeaderConfig(resolved, c, result.bindingSlotIndex);
    if (headerCfg.format) {
      const headerInput: HeaderInput = {
        limit: headerCfg.resolvedLimit,
        remaining: result.remaining,
        resetTime: result.resetTime,
        isBlocked: result.isBlocked,
        windowMs: headerCfg.resolvedWindowMs,
        identifier: headerCfg.identifier,
      };
      const { headers, legacyHeaders } = formatRateLimitHeaders(
        headerInput,
        headerCfg.format as HeaderFormat,
        headerCfg.includeLegacy,
      );
      applyHeadersToContext(c, headers);
      if (legacyHeaders) {
        applyHeadersToContext(c, legacyHeaders);
      }
    }

    if (result.isBlocked) {
      if (result.storeUnavailable || result.blockReason === 'service_unavailable') {
        return c.json(jsonErrorBody('Service temporarily unavailable'), toContentfulStatus(503));
      }
      if (result.blockReason === 'key_manager' && resolved.keyManager) {
        const status = resolved.statusCode ?? 429;
        const ra = keyManagerRetryAfterSeconds(resolved, key);
        if (ra !== undefined) {
          c.header('Retry-After', String(ra));
        }
        return c.json(keyManagerBlockedJson(resolved, key), toContentfulStatus(status));
      }

      if (result.blockReason === 'rate_limit' && options.onLimitReached) {
        await Promise.resolve(options.onLimitReached(c, key));
      }

      const status =
        result.blockReason === 'blocklist'
          ? (resolved.blocklistStatusCode ?? 403)
          : (resolved.statusCode ?? 429);

      if (result.blockReason === 'rate_limit' && typeof options.message === 'function') {
        return options.message(c);
      }

      const msg =
        result.blockReason === 'blocklist'
          ? (resolved.blocklistMessage ?? 'Forbidden')
          : (resolved.message ?? 'Too many requests');
      return c.json(jsonErrorBody(msg), toContentfulStatus(status));
    }

      c.set('rateLimitResult', result);
      c.set('rateLimit', toRateLimitInfo(resolved, result, c));

      return next();
    } catch (err: unknown) {
      // Log error for debugging (in production, consider using a logger)
      console.error('[ratelimit-flex/hono] Unexpected error in rate limiter:', err);
      return c.json(jsonErrorBody('Internal server error'), toContentfulStatus(500));
    }
  };

  return Object.assign(middleware, {
    metricsManager,
    getMetricsSnapshot: () => metricsManager.getSnapshot(),
    getMetricsHistory: () => metricsManager.getHistory(),
    shutdown: async () => {
      await metricsManager.shutdown();
    },
  }) as HonoRateLimiterHandler;
}
