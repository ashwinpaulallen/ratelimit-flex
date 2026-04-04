import type { NextFunction, Request, RequestHandler, Response } from 'express';

import {
  formatRateLimitHeaders,
  type HeaderInput,
  resolveHeaderConfig,
  resolveWindowMsForHeaders,
} from '../headers/index.js';
import { RateLimiterQueue, RateLimiterQueueError } from '../queue/RateLimiterQueue.js';
import { resolveCost, retryAfterSeconds } from '../queue/queue-middleware-utils.js';
import { defaultKeyGenerator } from '../strategies/rate-limit-engine.js';
import { RateLimitStrategy, type RateLimitOptions } from '../types/index.js';
import { getLimit, jsonErrorBody, mergeRateLimiterOptions } from './merge-options.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set after a queued token is acquired (same shape as {@link expressRateLimiter}). */
    rateLimit?: import('../types/index.js').RateLimitInfo;
  }
}

function applyHeaderMap(res: Response, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

export interface QueuedRateLimiterOptions {
  /** Window duration in ms */
  windowMs: number;
  /** Max requests per window */
  maxRequests: number;
  /** Rate limiting strategy (default: SLIDING_WINDOW) */
  strategy?: RateLimitStrategy;
  /**
   * Optional backing store. When omitted, a {@link MemoryStore} is created via
   * {@link mergeRateLimiterOptions} from `strategy`, `windowMs`, and `maxRequests`.
   * 
   * **Store ownership:** The queue takes ownership of the store. Calling `handler.queue.shutdown()`
   * (e.g., in a `SIGTERM` handler or Fastify `onClose` hook) will call `store.shutdown()`, closing
   * the store for all consumers. If you share a store across multiple queues or components, use
   * `queue.clear()` instead of `queue.shutdown()` to avoid closing the shared store prematurely.
   * 
   * @see {@link RateLimiterQueue.shutdown} for detailed examples
   */
  store?: import('../types/index.js').RateLimitStore;
  /** Max queue size (default: 100) */
  maxQueueSize?: number;
  /** Max wait time in queue in ms (default: 30_000 = 30 seconds) */
  maxQueueTimeMs?: number;
  /** Namespace for the internal {@link RateLimiterQueue} (default: `rlf-queued`) */
  keyPrefix?: string;
  /** Key generator (default: IP) */
  keyGenerator?: (req: unknown) => string;
  /** Status code when queue rejects (default: 429) */
  statusCode?: number;
  /** Response body when queue rejects */
  message?: string | object;
  /** Cost per request (default: 1) */
  incrementCost?: number | ((req: unknown) => number);
  /** Headers config */
  standardHeaders?: 'legacy' | 'draft-6' | 'draft-7' | 'draft-8' | boolean;
  /** When using draft standard headers, whether to also emit legacy `X-RateLimit-*` (default: false) */
  legacyHeaders?: boolean;
}

export interface ExpressQueuedRateLimiterHandler extends RequestHandler {
  /** The underlying queue (inspect size, `clear()`, `shutdown()`, etc.) */
  queue: RateLimiterQueue;
}

/**
 * Express middleware that **waits** for rate-limit capacity using {@link RateLimiterQueue} instead of
 * responding with 429 immediately when the window is full.
 * 
 * **Head-of-line blocking:** The queue is a single FIFO array. When a request for key "A" is blocked
 * (waiting for capacity), all subsequent requests for key "B" also wait, even if "B" has capacity.
 * This is typically fine for HTTP middleware (one queue per route), but be aware if using custom
 * `keyGenerator` with many different keys.
 *
 * @param options - Window limits, queue bounds, and header behavior.
 * @returns Express middleware with `.queue` attached for introspection.
 * @example Graceful shutdown:
 * ```ts
 * const limiter = expressQueuedRateLimiter({ maxRequests: 10, windowMs: 60_000 });
 * app.use(limiter);
 * 
 * process.on('SIGTERM', async () => {
 *   limiter.queue.shutdown(); // Clear pending requests
 *   await server.close();
 * });
 * ```
 * 
 * @see {@link RateLimiterQueueOptions} for head-of-line blocking details
 */
export function expressQueuedRateLimiter(options: QueuedRateLimiterOptions): ExpressQueuedRateLimiterHandler {
  const merged = mergeRateLimiterOptions({
    strategy: options.strategy ?? RateLimitStrategy.SLIDING_WINDOW,
    windowMs: options.windowMs,
    maxRequests: options.maxRequests,
    store: options.store,
    standardHeaders: options.standardHeaders ?? true,
    legacyHeaders: options.legacyHeaders ?? false,
  } satisfies Partial<RateLimitOptions>);

  const windowMsForQueue =
    merged.strategy === RateLimitStrategy.TOKEN_BUCKET
      ? (merged.interval ?? 60_000)
      : (merged.windowMs ?? 60_000);
  const maxCap = getLimit(merged, undefined);

  const maxQueueSize = options.maxQueueSize ?? 100;
  const maxQueueTimeMs = options.maxQueueTimeMs ?? 30_000;

  const queue = new RateLimiterQueue(
    merged.store,
    {
      windowMs: windowMsForQueue,
      maxRequests: maxCap,
      keyPrefix: options.keyPrefix ?? 'rlf-queued',
      strategy: merged.strategy,
    },
    {
      maxQueueSize,
      maxQueueTimeMs,
    },
  );

  const keyGen = options.keyGenerator ?? defaultKeyGenerator;
  const statusCode = options.statusCode ?? 429;

  const middleware = async function expressQueuedRateLimiterMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    let key: string;
    try {
      key = keyGen(req);
    } catch (err) {
      next(err);
      return;
    }

    const cost = resolveCost(req, options.incrementCost);

    try {
      const result = await queue.removeTokens(key, cost);

      const headerCfg = resolveHeaderConfig(merged, req);
      if (headerCfg.format) {
        const headerInput: HeaderInput = {
          limit: headerCfg.resolvedLimit,
          remaining: result.remaining,
          resetTime: result.resetTime,
          isBlocked: false,
          windowMs: resolveWindowMsForHeaders(merged),
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

      const limit = getLimit(merged, req);
      req.rateLimit = {
        limit,
        remaining: result.remaining,
        resetTime: result.resetTime,
        current: Math.max(0, limit - result.remaining),
      };

      next();
    } catch (err: unknown) {
      if (err instanceof RateLimiterQueueError) {
        const retrySec = retryAfterSeconds(err, maxQueueTimeMs);
        res.setHeader('Retry-After', String(retrySec));
        const body = options.message ?? err.message;
        res.status(statusCode).json(jsonErrorBody(body));
        return;
      }
      next(err);
    }
  };

  const handler = middleware as ExpressQueuedRateLimiterHandler;
  handler.queue = queue;
  return handler;
}
