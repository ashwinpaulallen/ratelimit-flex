import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { OpenTelemetryAdapter } from '../metrics/adapters/opentelemetry-adapter.js';
import {
  formatRateLimitHeaders,
  type HeaderInput,
  resolveHeaderConfig,
} from '../headers/index.js';
import { MetricsManager } from '../metrics/manager.js';
import {
  RateLimitEngine,
  defaultKeyGenerator,
  matchingDecrementOptions,
  resolveIncrementOpts,
} from '../strategies/rate-limit-engine.js';
import type { KeyManager } from '../key-manager/KeyManager.js';
import type {
  RateLimitConsumeResult,
  RateLimitInfo,
  RateLimitOptions,
  WindowRateLimitOptions,
} from '../types/index.js';
import type { MetricsSnapshot } from '../types/metrics.js';
import { warnIfMemoryStoreInCluster, warnIfRedisStoreWithoutInsurance } from '../utils/environment.js';
import type { InMemoryShield } from '../shield/InMemoryShield.js';
import {
  jsonErrorBody,
  keyManagerBlockedJson,
  keyManagerRetryAfterSeconds,
  mergeRateLimiterOptions,
  resolveStoreWithInMemoryShield,
  toRateLimitInfo,
} from './merge-options.js';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * @description Snapshot after a successful consume (not blocked). Set by {@link expressRateLimiter}.
     * @default undefined
     */
    rateLimit?: RateLimitInfo;
    /**
     * @description When the backing store is a {@link ComposedStore}, the last {@link RateLimitEngine.consumeWithKey} result (including `layers`). Set whenever `result.layers` is present.
     * @default undefined
     * @since 2.0.0
     */
    rateLimitComposed?: RateLimitConsumeResult;
  }
}

function applyHeaderMap(res: Response, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

function decrementStores(resolved: RateLimitOptions, key: string, req: unknown): void {
  const incOpts = resolveIncrementOpts(resolved, req);
  const decOpts = matchingDecrementOptions(incOpts);
  const w = resolved as WindowRateLimitOptions;
  if (w.groupedWindowStores && w.groupedWindowStores.length > 0) {
    for (const g of w.groupedWindowStores) {
      void g.store.decrement(key, decOpts).catch(() => {
        /* ignore */
      });
    }
    return;
  }
  void resolved.store.decrement(key, decOpts).catch(() => {
    /* ignore */
  });
}

/**
 * Express rate limiter with optional {@link RateLimitOptions.metrics}: `getMetricsSnapshot`, `getMetricsHistory`, `metricsEndpoint`, `on('metrics')`.
 *
 * @since 1.3.0
 */
export interface ExpressRateLimiterHandler extends RequestHandler {
  /** Aggregated metrics wiring (no-op when metrics disabled). */
  metricsManager: MetricsManager;
  getMetricsSnapshot(): MetricsSnapshot | null;
  getMetricsHistory(): MetricsSnapshot[];
  /** Alias of {@link getMetricsHistory}. */
  getHistory(): MetricsSnapshot[];
  /** Prometheus exposition middleware when `metrics.prometheus.enabled`; otherwise `undefined`. */
  metricsEndpoint?: RequestHandler;
  on(event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): this;
  off(event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): this;
  once(event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): this;
  removeListener(event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): this;
  /**
   * Stops the metrics collector and adapters (OpenTelemetry observable callbacks, Prometheus listeners).
   * Call alongside `store.shutdown()` when your store exposes shutdown.
   */
  shutdownMetrics(): Promise<void>;
  /** Present when `metrics.openTelemetry` is enabled with a `meter`. */
  openTelemetryAdapter?: OpenTelemetryAdapter;
  /**
   * When {@link RateLimitOptionsBase.keyManager} is set, or auto-created from `penaltyBox`.
   * @since 2.2.0
   */
  keyManager?: KeyManager;
  /**
   * Present when {@link RateLimitOptionsBase.inMemoryBlock} wrapped the backing store with {@link InMemoryShield}.
   * @since 2.3.0
   */
  shield: InMemoryShield | null;
}

/**
 * Express middleware: merges options, warns if {@link MemoryStore} is used in a likely multi-instance environment, then runs {@link RateLimitEngine.consumeWithKey} per request.
 *
 * @description
 * - Blocked responses: **429** (rate limit), **403** (blocklist), **503** (Redis fail-closed / service unavailable).
 * - On allow: sets `req.rateLimit` and optional `X-RateLimit-*` headers; when the store reports {@link RateLimitResult.storeUnavailable}, adds **`X-RateLimit-Store: fallback`** (insurance / degraded path).
 * - **`incrementCost`** / weighted increments: skip-response decrements use {@link matchingDecrementOptions} so rollback matches consumed quota.
 * @param options - Partial {@link RateLimitOptions}; `store` defaults to a new {@link MemoryStore} when omitted (unless `limits` is used).
 * @returns Express `RequestHandler` with {@link ExpressRateLimiterHandler}: always includes {@link MetricsManager} and snapshot/history/Prometheus helpers (no-ops when `metrics` is disabled).
 * @example
 * ```ts
 * import express from 'express';
 * import { expressRateLimiter } from 'ratelimit-flex';
 *
 * const app = express();
 * app.use(expressRateLimiter({ maxRequests: 50, windowMs: 60_000 }));
 * ```
 * @throws Errors from `keyGenerator` or `onLimitReached` propagate via `next(err)`.
 * @see {@link fastifyRateLimiter}
 * @see {@link RateLimitEngine}
 * @see {@link warnIfMemoryStoreInCluster}
 * @since 1.0.0
 */
export function expressRateLimiter(options: Partial<RateLimitOptions>): ExpressRateLimiterHandler {
  const merged = mergeRateLimiterOptions(options);
  const { optionsForEngine: resolved, shield } = resolveStoreWithInMemoryShield(merged);
  warnIfMemoryStoreInCluster(resolved.store);
  warnIfRedisStoreWithoutInsurance(resolved.store);
  const metricsManager = new MetricsManager(resolved.metrics, shield);
  const { onLimitReached, ...engineOptions } = resolved;
  const engine = new RateLimitEngine(engineOptions, metricsManager.getCounters() ?? undefined);
  const keyGen = resolved.keyGenerator ?? defaultKeyGenerator;

  let metricsCollectorStarted = false;
  const rateLimitMiddleware = async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!metricsCollectorStarted && metricsManager.getCounters()) {
      metricsManager.start();
      metricsCollectorStarted = true;
    }

    let key: string;
    try {
      key = keyGen(req);
      const result = await engine.consumeWithKey(key, req);

      if (result.layers) {
        req.rateLimitComposed = result;
      }

      if (result.storeUnavailable === true) {
        res.setHeader('X-RateLimit-Store', 'fallback');
      }

      const headerCfg = resolveHeaderConfig(resolved, req, result.bindingSlotIndex);
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
          headerCfg.format,
          headerCfg.includeLegacy,
        );
        applyHeaderMap(res, headers);
        if (legacyHeaders) {
          applyHeaderMap(res, legacyHeaders);
        }
      }

      if (result.isBlocked) {
        // 503 first: Redis fail-closed. Blocklist/penalty never reach the store (engine order), so they
        // cannot collide with storeUnavailable on the same response.
        if (result.storeUnavailable || result.blockReason === 'service_unavailable') {
          res.status(503).json(jsonErrorBody('Service temporarily unavailable'));
          return;
        }
        if (result.blockReason === 'key_manager' && resolved.keyManager) {
          const status = resolved.statusCode ?? 429;
          const ra = keyManagerRetryAfterSeconds(resolved, key);
          if (ra !== undefined) {
            res.setHeader('Retry-After', String(ra));
          }
          res.status(status).json(keyManagerBlockedJson(resolved, key));
          return;
        }
        if (onLimitReached && result.blockReason === 'rate_limit') {
          await Promise.resolve(onLimitReached(req, result));
        }
        const status =
          result.blockReason === 'blocklist'
            ? (resolved.blocklistStatusCode ?? 403)
            : (resolved.statusCode ?? 429);
        const msg =
          result.blockReason === 'blocklist'
            ? (resolved.blocklistMessage ?? 'Forbidden')
            : (resolved.message ?? 'Too many requests');
        res.status(status).json(jsonErrorBody(msg));
        return;
      }

      req.rateLimit = toRateLimitInfo(resolved, result, req);

      const shouldDecrementFailed = resolved.skipFailedRequests === true;
      const shouldDecrementSuccess = resolved.skipSuccessfulRequests === true;

      if (shouldDecrementFailed || shouldDecrementSuccess) {
        res.once('finish', () => {
          const status = res.statusCode;
          const failed = status >= 400;
          const success = status < 400;
          if ((shouldDecrementFailed && failed) || (shouldDecrementSuccess && success)) {
            decrementStores(resolved, key, req);
          }
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };

  const prometheusMw = metricsManager.getPrometheusMiddleware() ?? undefined;

  const handler = rateLimitMiddleware as ExpressRateLimiterHandler;
  handler.metricsManager = metricsManager;
  handler.metricsEndpoint = prometheusMw;
  handler.getMetricsSnapshot = (): MetricsSnapshot | null => metricsManager.getSnapshot();
  handler.getMetricsHistory = (): MetricsSnapshot[] => metricsManager.getHistory();
  handler.getHistory = (): MetricsSnapshot[] => metricsManager.getHistory();
  handler.on = (_event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): ExpressRateLimiterHandler => {
    metricsManager.on('metrics', listener);
    return handler;
  };
  handler.off = (_event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): ExpressRateLimiterHandler => {
    metricsManager.off('metrics', listener);
    return handler;
  };
  handler.once = (_event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): ExpressRateLimiterHandler => {
    metricsManager.once('metrics', listener);
    return handler;
  };
  handler.removeListener = (
    _event: 'metrics',
    listener: (snapshot: MetricsSnapshot) => void,
  ): ExpressRateLimiterHandler => {
    metricsManager.removeListener('metrics', listener);
    return handler;
  };
  handler.shutdownMetrics = async (): Promise<void> => {
    await metricsManager.shutdown();
  };
  handler.openTelemetryAdapter = metricsManager.getOpenTelemetryAdapter() ?? undefined;
  handler.keyManager = resolved.keyManager;
  handler.shield = shield;

  return handler;
}
