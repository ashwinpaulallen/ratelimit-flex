import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { OpenTelemetryAdapter } from '../metrics/adapters/opentelemetry-adapter.js';
import { MetricsManager } from '../metrics/manager.js';
import { RateLimitEngine, defaultKeyGenerator } from '../strategies/rate-limit-engine.js';
import type { RateLimitInfo, RateLimitOptions, WindowRateLimitOptions } from '../types/index.js';
import type { MetricsSnapshot } from '../types/metrics.js';
import { warnIfMemoryStoreInCluster } from '../utils/environment.js';
import { jsonErrorBody, mergeRateLimiterOptions, toRateLimitInfo } from './merge-options.js';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * @description Snapshot after a successful consume (not blocked). Set by {@link expressRateLimiter}.
     * @default undefined
     */
    rateLimit?: RateLimitInfo;
  }
}

function applyHeaders(res: Response, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

function decrementStores(resolved: RateLimitOptions, key: string): void {
  const w = resolved as WindowRateLimitOptions;
  if (w.groupedWindowStores && w.groupedWindowStores.length > 0) {
    for (const g of w.groupedWindowStores) {
      void g.store.decrement(key).catch(() => {
        /* ignore */
      });
    }
    return;
  }
  void resolved.store.decrement(key).catch(() => {
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
}

/**
 * Express middleware: merges options, warns if {@link MemoryStore} is used in a likely multi-instance environment, then runs {@link RateLimitEngine.consumeWithKey} per request.
 *
 * @description
 * - Blocked responses: **429** (rate limit), **403** (blocklist), **503** (Redis fail-closed / service unavailable).
 * - On allow: sets `req.rateLimit` and optional `X-RateLimit-*` headers.
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
  const resolved = mergeRateLimiterOptions(options);
  warnIfMemoryStoreInCluster(resolved.store);
  const metricsManager = new MetricsManager(resolved.metrics);
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

      if (resolved.headers !== false) {
        applyHeaders(res, result.headers);
      }

      if (result.isBlocked) {
        // 503 first: Redis fail-closed. Blocklist/penalty never reach the store (engine order), so they
        // cannot collide with storeUnavailable on the same response.
        if (result.storeUnavailable || result.blockReason === 'service_unavailable') {
          res.status(503).json(jsonErrorBody('Service temporarily unavailable'));
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
            decrementStores(resolved, key);
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

  return handler;
}
