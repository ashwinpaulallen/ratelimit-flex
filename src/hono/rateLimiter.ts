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
import { decrementStoresAfterConsumeAsync } from '../middleware/decrement-stores-after-consume.js';
import type { InMemoryShield } from '../shield/InMemoryShield.js';
import type { KeyManager } from '../key-manager/KeyManager.js';
import type { RateLimitConsumeResult, RateLimitInfo, RateLimitOptions } from '../types/index.js';
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
    /** When the backing store is composed, last consume result with `layers` (Express `req.rateLimitComposed`). */
    rateLimitComposed?: RateLimitConsumeResult;
    /** @internal Per-request cost for {@link HonoRateLimitOptions.cost}. */
    'ratelimitFlex:incrementCost'?: number;
  }
}

/**
 * Hono rate limiter options: full {@link RateLimitOptions} engine surface (including `limits`,
 * {@link RateLimitOptionsBase.draft}, composed stores, {@link RateLimitOptionsBase.groupedWindowStores},
 * {@link RateLimitOptionsBase.penaltyBox}, {@link RateLimitOptionsBase.keyManager}) plus Hono-specific fields.
 *
 * @remarks
 * **`skip` / `onLimitReached`:** Hono-specific signatures; not passed to {@link mergeRateLimiterOptions} — handled
 * in middleware only (same pattern as Express stripping `onLimitReached` from the engine).
 *
 * **`skipFailedRequests` / `skipSuccessfulRequests`:** When set, the middleware **`await`s `next()`** after a
 * successful consume, then uses {@link resolvedHonoRollbackStatus} and decrements when the status matches
 * Express / Fastify semantics. Uses {@link resolveIncrementOpts} / {@link matchingDecrementOptions} for weighted,
 * grouped, and composed stores. With {@link waitUntil}, decrements run on that hook (Cloudflare Workers).
 */
export type HonoRateLimitOptions = Omit<
  Partial<RateLimitOptions>,
  'keyGenerator' | 'message' | 'skip' | 'onLimitReached' | 'incrementCost'
> & {
  /**
   * Key generator. Receives the Hono {@link Context}.
   * Default uses `x-forwarded-for` / `x-real-ip`. On edge runtimes, IP may be missing unless the platform
   * sets these headers — prefer an explicit key (API key, session id) in production.
   */
  keyGenerator?: (c: Context) => string | Promise<string>;
  /** Response body when rate limited (not used when `message` is a function returning a `Response`). */
  message?: string | object | ((c: Context) => Response | Promise<Response>);
  /** Skip rate limiting for this request (async supported). Handled in middleware only. */
  skip?: (c: Context) => boolean | Promise<boolean>;
  /** Called when blocked by the rate limit (not blocklist / 503). Handled in middleware only. */
  onLimitReached?: (c: Context, key: string) => void | Promise<void>;
  /**
   * Called when the middleware throws. After this runs, the error is **re-thrown** so Hono’s error pipeline runs.
   */
  onError?: (err: unknown, c: Context) => void | Promise<void>;
  /** Shorthand for weighted quota; overridden by {@link incrementCost} when both are set. */
  cost?: number | ((c: Context) => number | Promise<number>);
  /** Same as {@link RateLimitOptionsBase.incrementCost} (`req` is the Hono {@link Context}). */
  incrementCost?: number | ((req: unknown) => number);
  /**
   * Cloudflare Workers: pass `c.executionCtx.waitUntil` so skip-response `decrement` work does not block the
   * response (optional; local Node ignores it).
   */
  waitUntil?: (promise: Promise<unknown>) => void;
};

export function honoDefaultKeyGenerator(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
}

/**
 * Maps Hono options to {@link mergeRateLimiterOptions} input: all engine fields, plus `incrementCost` / `message`
 * shims. Does not include `skip` / `onLimitReached` (middleware-only).
 *
 * @internal Exported for {@link queuedRateLimiter} parity with {@link rateLimiter}.
 */
export function buildHonoMergePartial(h: HonoRateLimitOptions): Partial<RateLimitOptions> {
  const { message, cost, incrementCost: incFromOpts } = h;
  const raw = { ...h } as Record<string, unknown>;
  delete raw.keyGenerator;
  delete raw.message;
  delete raw.skip;
  delete raw.onLimitReached;
  delete raw.onError;
  delete raw.cost;
  delete raw.waitUntil;
  const engineFields = raw as Partial<RateLimitOptions>;

  const messageForMerge =
    message !== undefined && typeof message !== 'function' ? message : undefined;

  const incrementCost: RateLimitOptions['incrementCost'] | undefined =
    incFromOpts !== undefined
      ? incFromOpts
      : cost !== undefined
        ? (req: unknown) => {
            const ctx = req as Context;
            const v = ctx.get(HONO_RATE_LIMIT_INCREMENT_COST);
            if (typeof v === 'number' && Number.isFinite(v)) {
              return v;
            }
            return 1;
          }
        : undefined;

  return {
    ...engineFields,
    message: messageForMerge,
    incrementCost,
  };
}

/** @internal Per-request cost for {@link HonoRateLimitOptions.cost} (also used by {@link queuedRateLimiter}). */
export async function resolveHonoRequestCost(c: Context, h: HonoRateLimitOptions): Promise<number> {
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
  const merged = mergeRateLimiterOptions(buildHonoMergePartial(options));
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

      c.set(HONO_RATE_LIMIT_INCREMENT_COST, await resolveHonoRequestCost(c, options));

      const result = await engine.consumeWithKey(key, c);

      if (result.layers) {
        c.set('rateLimitComposed', result);
      }

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
          const p = decrementStoresAfterConsumeAsync(resolved, key, c);
          if (options.waitUntil !== undefined) {
            options.waitUntil(p);
          } else {
            void p;
          }
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
