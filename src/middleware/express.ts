import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RateLimitEngine, defaultKeyGenerator } from '../strategies/rate-limit-engine.js';
import type { RateLimitInfo, RateLimitOptions, WindowRateLimitOptions } from '../types/index.js';
import { jsonErrorBody, mergeRateLimiterOptions, toRateLimitInfo } from './merge-options.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Populated by {@link expressRateLimiter} after a successful consume (not blocked). */
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
 * Express middleware factory. One {@link RateLimitEngine} and store are created per call (singleton for that middleware instance).
 *
 * @example
 * ```ts
 * app.use(expressRateLimiter({ maxRequests: 50 }));
 * ```
 */
export function expressRateLimiter(options: Partial<RateLimitOptions>): RequestHandler {
  const resolved = mergeRateLimiterOptions(options);
  const { onLimitReached, ...engineOptions } = resolved;
  const engine = new RateLimitEngine(engineOptions);
  const keyGen = resolved.keyGenerator ?? defaultKeyGenerator;

  return async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    if (resolved.skip?.(req) === true) {
      next();
      return;
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
}
