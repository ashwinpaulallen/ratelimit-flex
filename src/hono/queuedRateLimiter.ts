import type { MiddlewareHandler } from 'hono';
import {
  formatRateLimitHeaders,
  type HeaderInput,
  resolveHeaderConfig,
  resolveWindowMsForHeaders,
} from '../headers/index.js';
import {
  getLimit,
  jsonErrorBody,
  mergeRateLimiterOptions,
  resolveStoreWithInMemoryShield,
} from '../middleware/merge-options.js';
import { MetricsManager } from '../metrics/manager.js';
import { RateLimiterQueue, RateLimiterQueueError } from '../queue/RateLimiterQueue.js';
import { resolveCost, retryAfterSeconds } from '../queue/queue-middleware-utils.js';
import { resolveIncrementOpts } from '../strategies/rate-limit-engine.js';
import { RateLimitStrategy } from '../types/index.js';
import type { MetricsSnapshot } from '../types/metrics.js';
import { sanitizeIncrementCost } from '../utils/clamp.js';
import { warnIfMemoryStoreInCluster, warnIfRedisStoreWithoutInsurance } from '../utils/environment.js';
import {
  buildHonoMergePartial,
  HONO_RATE_LIMIT_INCREMENT_COST,
  honoDefaultKeyGenerator,
  resolveHonoRequestCost,
  type HonoRateLimitOptions,
  type HonoRateLimiterHandler,
} from './rateLimiter.js';
import { applyHeadersToContext, toContentfulStatus } from './utils.js';

export type HonoQueuedRateLimitOptions = HonoRateLimitOptions & {
  /** Max waiting requests (default: 100, same as Express queued). */
  maxQueueSize?: number;
  /** Max time to wait for capacity in ms (default: 30_000). */
  maxQueueTimeMs?: number;
  /** Prefix for internal queue keys (default: `rlf-queued`). */
  keyPrefix?: string;
};

/** Queued middleware plus {@link RateLimiterQueue} and the same metrics surface as {@link HonoRateLimiterHandler}. */
export interface HonoQueuedRateLimiterHandler extends HonoRateLimiterHandler {
  queue: RateLimiterQueue;
}

/**
 * Hono middleware that **waits** for capacity via {@link RateLimiterQueue} (same semantics as
 * {@link expressQueuedRateLimiter}).
 *
 * @remarks
 * Options are merged with {@link buildHonoMergePartial} / {@link mergeRateLimiterOptions} — same surface as
 * {@link rateLimiter} (`limits`, composed stores, `inMemoryBlock`, `metrics`, headers, etc.). The queue still
 * calls {@link RateLimitStore.increment} on the resolved store only; policy features that require
 * {@link RateLimitEngine} (e.g. `draft`, `penaltyBox` / `keyManager` blocks before increment) are not applied on
 * this path (same limitation as {@link expressQueuedRateLimiter}).
 *
 * @remarks
 * Head-of-line blocking applies to the shared FIFO queue — see {@link RateLimiterQueue}.
 */
export function queuedRateLimiter(options: HonoQueuedRateLimitOptions = {}): HonoQueuedRateLimiterHandler {
  const { maxQueueSize, maxQueueTimeMs, keyPrefix, ...honoRest } = options;
  const partial = buildHonoMergePartial(honoRest);
  const merged = mergeRateLimiterOptions({
    ...partial,
    standardHeaders: partial.standardHeaders ?? true,
  });
  const { optionsForEngine: resolved, shield } = resolveStoreWithInMemoryShield(merged);
  warnIfMemoryStoreInCluster(resolved.store);
  warnIfRedisStoreWithoutInsurance(resolved.store);

  const metricsManager = new MetricsManager(resolved.metrics, shield);
  let metricsCollectorStarted = false;

  const windowMsForQueue =
    resolved.strategy === RateLimitStrategy.TOKEN_BUCKET
      ? (resolved.interval ?? 60_000)
      : (resolved.windowMs ?? 60_000);
  const maxCap = getLimit(resolved, undefined);

  const queue = new RateLimiterQueue(
    resolved.store,
    {
      windowMs: windowMsForQueue,
      maxRequests: maxCap,
      keyPrefix: keyPrefix ?? 'rlf-queued',
      strategy: resolved.strategy,
    },
    {
      maxQueueSize: maxQueueSize ?? 100,
      maxQueueTimeMs: maxQueueTimeMs ?? 30_000,
    },
  );

  const keyFromContext = options.keyGenerator ?? honoDefaultKeyGenerator;
  const rejectStatus = options.statusCode ?? 429;
  const prometheusMw = metricsManager.getPrometheusMiddleware() ?? undefined;

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
      const incOpts = resolveIncrementOpts(resolved, c);
      const cost = sanitizeIncrementCost(incOpts?.cost ?? resolveCost(c, resolved.incrementCost), 1);

      if (resolved.allowlist?.includes(key)) {
        return next();
      }
      if (resolved.blocklist?.includes(key)) {
        const msg = resolved.blocklistMessage ?? 'Forbidden';
        return c.json(jsonErrorBody(msg), toContentfulStatus(resolved.blocklistStatusCode ?? 403));
      }

      try {
        const result = await queue.removeTokens(key, cost);

        const headerCfg = resolveHeaderConfig(resolved, c);
        if (headerCfg.format) {
          const headerInput: HeaderInput = {
            limit: headerCfg.resolvedLimit,
            remaining: result.remaining,
            resetTime: result.resetTime,
            isBlocked: false,
            windowMs: resolveWindowMsForHeaders(resolved),
            identifier: headerCfg.identifier,
          };
          const { headers, legacyHeaders } = formatRateLimitHeaders(
            headerInput,
            headerCfg.format,
            headerCfg.includeLegacy,
          );
          applyHeadersToContext(c, headers);
          if (legacyHeaders) {
            applyHeadersToContext(c, legacyHeaders);
          }
        }

        const limit = getLimit(resolved, c);
        c.set('rateLimit', {
          limit,
          remaining: result.remaining,
          resetTime: result.resetTime,
          current: Math.max(0, limit - result.remaining),
        });

        return next();
      } catch (err: unknown) {
        if (err instanceof RateLimiterQueueError) {
          const retrySec = retryAfterSeconds(err, maxQueueTimeMs ?? 30_000);
          c.header('Retry-After', String(retrySec));
          const m = options.message;
          if (typeof m === 'function') {
            return m(c);
          }
          const payload: string | object = m === undefined ? err.message : m;
          return c.json(jsonErrorBody(payload), toContentfulStatus(rejectStatus));
        }
        throw err;
      }
    } catch (err: unknown) {
      if (options.onError !== undefined) {
        await Promise.resolve(options.onError(err, c));
      }
      throw err;
    }
  };

  const handler = middleware as HonoQueuedRateLimiterHandler;
  handler.queue = queue;
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
  handler.on = (_event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): HonoQueuedRateLimiterHandler => {
    metricsManager.on('metrics', listener);
    return handler;
  };
  handler.off = (_event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): HonoQueuedRateLimiterHandler => {
    metricsManager.off('metrics', listener);
    return handler;
  };
  handler.once = (_event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): HonoQueuedRateLimiterHandler => {
    metricsManager.once('metrics', listener);
    return handler;
  };
  handler.removeListener = (
    _event: 'metrics',
    listener: (snapshot: MetricsSnapshot) => void,
  ): HonoQueuedRateLimiterHandler => {
    metricsManager.removeListener('metrics', listener);
    return handler;
  };
  handler.keyManager = resolved.keyManager;
  handler.shield = shield;
  handler.openTelemetryAdapter = metricsManager.getOpenTelemetryAdapter() ?? undefined;

  return handler;
}
