import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RateLimitEngine, defaultKeyGenerator } from '../strategies/rate-limit-engine.js';
import type { RateLimitInfo, RateLimitOptions } from '../types/index.js';
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

    const key = keyGen(req);

    const result = await engine.consumeWithKey(key, req);

    if (resolved.headers !== false) {
      applyHeaders(res, result.headers);
    }

    if (result.isBlocked) {
      if (onLimitReached) {
        await Promise.resolve(onLimitReached(req, result));
      }
      res
        .status(resolved.statusCode ?? 429)
        .json(jsonErrorBody(resolved.message ?? 'Too many requests'));
      return;
    }

    req.rateLimit = toRateLimitInfo(resolved, result);

    const shouldDecrementFailed = resolved.skipFailedRequests === true;
    const shouldDecrementSuccess = resolved.skipSuccessfulRequests === true;

    if (shouldDecrementFailed || shouldDecrementSuccess) {
      res.once('finish', () => {
        const status = res.statusCode;
        const failed = status >= 400;
        const success = status < 400;
        if ((shouldDecrementFailed && failed) || (shouldDecrementSuccess && success)) {
          void resolved.store.decrement(key).catch(() => {
            /* ignore */
          });
        }
      });
    }

    next();
  };
}
