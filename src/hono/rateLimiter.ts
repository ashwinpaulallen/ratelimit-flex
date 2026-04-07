import type { NextFunction, Request, Response } from 'express';
import type { Context, MiddlewareHandler } from 'hono';
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
import { decrementStoresAfterConsume } from '../middleware/decrement-stores-after-consume.js';
import type { InMemoryShield } from '../shield/InMemoryShield.js';
import type { InMemoryShieldOptions } from '../shield/types.js';
import type { KeyManager } from '../key-manager/KeyManager.js';
import type {
  RateLimitConsumeResult,
  RateLimitInfo,
  RateLimitOptions,
  RateLimitStore,
  RateLimitStrategy,
} from '../types/index.js';
import type { StandardHeadersDraft } from '../types/index.js';
import type { MetricsConfig } from '../types/metrics.js';
import { warnIfMemoryStoreInCluster, warnIfRedisStoreWithoutInsurance } from '../utils/environment.js';
import type { OpenTelemetryAdapter } from '../metrics/adapters/opentelemetry-adapter.js';
import { MetricsManager } from '../metrics/manager.js';
import type { MetricsSnapshot } from '../types/metrics.js';
import { applyHeadersToContext, resolvedHonoRollbackStatus, toContentfulStatus } from './utils.js';

/** Internal context key for per-request weighted cost (see {@link HonoRateLimitOptions.cost}). */
export const HONO_RATE_LIMIT_INCREMENT_COST = 'ratelimitFlex:incrementCost' as const;

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
 * **`skipFailedRequests` / `skipSuccessfulRequests`:** When set, the middleware **`await`s `next()`** after a
 * successful consume, then uses {@link resolvedHonoRollbackStatus} and decrements when the status matches
 * Express / Fastify semantics (failed ≥ `400` vs successful `< 400`). Uses
 * {@link resolveIncrementOpts} / {@link matchingDecrementOptions} for weighted / grouped windows.
 * For modes that need a different rule than HTTP status, add a follow-up middleware (README **Hono → Limitations**).
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

  /**
   * Aggregated metrics / optional Prometheus / OTel (same as {@link RateLimitOptions.metrics}).
   * Wired into the returned handler’s {@link HonoRateLimiterHandler.metricsManager}.
   */
  metrics?: MetricsConfig | boolean;

  /** Called when a request is blocked by the **rate limit** (not blocklist / 503). After this runs, the middleware sends the JSON error unless `message` is a function that returns a `Response`. */
  onLimitReached?: (c: Context, key: string) => void | Promise<void>;

  /**
   * Called when the middleware throws (e.g. store / `keyGenerator` / `consumeWithKey` failure).
   * After this runs, the error is **re-thrown** so Hono’s error pipeline runs (same idea as Express `next(err)`).
   * Omit to propagate only; use `app.onError()` for response formatting.
   */
  onError?: (err: unknown, c: Context) => void | Promise<void>;

  /**
   * After `await next()`, decrement when the resolved status is **≥ 400** (same as Express
   * {@link RateLimitOptions.skipFailedRequests}). Status is read from **`c.res`** via
   * {@link resolvedHonoRollbackStatus} (invalid or missing codes default to **200**).
   */
  skipFailedRequests?: boolean;

  /**
   * After `await next()`, decrement when the resolved status is **< 400** (same as Express
   * {@link RateLimitOptions.skipSuccessfulRequests}). See {@link resolvedHonoRollbackStatus}.
   */
  skipSuccessfulRequests?: boolean;
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
    metrics: h.metrics,
    skipFailedRequests: h.skipFailedRequests,
    skipSuccessfulRequests: h.skipSuccessfulRequests,
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

/**
 * Extended middleware handler with metrics support (parity with the Express adapter where applicable).
 */
export interface HonoRateLimiterHandler extends MiddlewareHandler {
  /** Metrics manager instance (no-op when metrics disabled). */
  metricsManager: MetricsManager;
  getMetricsSnapshot(): MetricsSnapshot | null;
  getMetricsHistory(): MetricsSnapshot[];
  /** Alias of {@link getMetricsHistory}. */
  getHistory(): MetricsSnapshot[];
  /** Shutdown metrics collector and adapters (same as {@link shutdownMetrics}). */
  shutdown(): Promise<void>;
  /** Alias of {@link shutdown} for parity with Express. */
  shutdownMetrics(): Promise<void>;
  /** Prometheus exposition middleware when `metrics.prometheus.enabled`; otherwise `undefined` (Express-style; use `metricsManager` for raw text in Hono). */
  metricsEndpoint?: (req: Request, res: Response, next: NextFunction) => void;
  on(event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): HonoRateLimiterHandler;
  off(event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): HonoRateLimiterHandler;
  once(event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): HonoRateLimiterHandler;
  removeListener(event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): HonoRateLimiterHandler;
  /** When {@link RateLimitOptionsBase.keyManager} is set, or auto-created from `penaltyBox`. */
  keyManager?: KeyManager;
  /** When `inMemoryBlock` wrapped the store with {@link InMemoryShield}. */
  shield: InMemoryShield | null;
  /** Present when `metrics.openTelemetry` is enabled with a `meter`. */
  openTelemetryAdapter?: OpenTelemetryAdapter;
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
 *   metrics: { enabled: true, intervalMs: 10_000 }
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

      await next();

      const shouldDecrementFailed = resolved.skipFailedRequests === true;
      const shouldDecrementSuccess = resolved.skipSuccessfulRequests === true;
      if (shouldDecrementFailed || shouldDecrementSuccess) {
        const status = resolvedHonoRollbackStatus(c);
        const failed = status >= 400;
        const success = status < 400;
        if ((shouldDecrementFailed && failed) || (shouldDecrementSuccess && success)) {
          decrementStoresAfterConsume(resolved, key, c);
        }
      }
      return;
    } catch (err: unknown) {
      if (options.onError !== undefined) {
        await Promise.resolve(options.onError(err, c));
      }
      throw err;
    }
  };

  const prometheusMw = metricsManager.getPrometheusMiddleware() ?? undefined;

  const handler = middleware as HonoRateLimiterHandler;
  handler.metricsManager = metricsManager;
  handler.metricsEndpoint = prometheusMw;
  handler.getMetricsSnapshot = (): MetricsSnapshot | null => metricsManager.getSnapshot();
  handler.getMetricsHistory = (): MetricsSnapshot[] => metricsManager.getHistory();
  handler.getHistory = (): MetricsSnapshot[] => metricsManager.getHistory();
  handler.shutdown = async (): Promise<void> => {
    await metricsManager.shutdown();
  };
  handler.shutdownMetrics = async (): Promise<void> => {
    await metricsManager.shutdown();
  };
  handler.on = (_event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): HonoRateLimiterHandler => {
    metricsManager.on('metrics', listener);
    return handler;
  };
  handler.off = (_event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): HonoRateLimiterHandler => {
    metricsManager.off('metrics', listener);
    return handler;
  };
  handler.once = (_event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): HonoRateLimiterHandler => {
    metricsManager.once('metrics', listener);
    return handler;
  };
  handler.removeListener = (
    _event: 'metrics',
    listener: (snapshot: MetricsSnapshot) => void,
  ): HonoRateLimiterHandler => {
    metricsManager.removeListener('metrics', listener);
    return handler;
  };
  handler.keyManager = resolved.keyManager;
  handler.shield = shield;
  handler.openTelemetryAdapter = metricsManager.getOpenTelemetryAdapter() ?? undefined;

  return handler;
}
