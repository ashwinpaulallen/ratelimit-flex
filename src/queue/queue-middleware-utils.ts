/**
 * Shared utilities for queued rate limiting middleware (Express and Fastify).
 * 
 * @internal
 * @since 1.5.0
 */

import { sanitizeIncrementCost } from '../utils/clamp.js';
import type { ShutdownError } from './errors.js';
import { RateLimiterQueueError } from './RateLimiterQueue.js';

/**
 * Resolve the cost (token weight) for a request from static or dynamic `incrementCost` option.
 * 
 * @param req - Framework request object
 * @param incrementCost - Static number or function that returns cost
 * @returns Sanitized cost (minimum 1)
 */
export function resolveCost(
  req: unknown,
  incrementCost: number | ((req: unknown) => number) | undefined,
): number {
  if (typeof incrementCost === 'function') {
    return sanitizeIncrementCost(incrementCost(req), 1);
  }
  return sanitizeIncrementCost(incrementCost ?? 1, 1);
}

/**
 * Calculate Retry-After header value (in seconds) from a {@link RateLimiterQueueError}.
 * 
 * @param err - Queue error with typed `code` field
 * @param maxQueueTimeMs - Maximum queue wait time in milliseconds
 * @returns Retry-After value in seconds
 */
export function retryAfterSeconds(err: RateLimiterQueueError, maxQueueTimeMs: number): number {
  if (err.code === 'queue_timeout') {
    return Math.max(1, Math.ceil(maxQueueTimeMs / 1000));
  }
  return 1;
}

/**
 * JSON body for queued middleware when the queue is shut down (503).
 * Always includes {@link ShutdownError.code} so clients can branch on `E_RATELIMIT_SHUTDOWN`.
 */
export function queuedShutdownErrorJson(
  err: ShutdownError,
  message: string | object | undefined,
): Record<string, unknown> & { code: string } {
  if (message === undefined) {
    return { error: 'Service shutting down', code: err.code };
  }
  if (typeof message === 'object' && message !== null) {
    return { ...(message as Record<string, unknown>), code: err.code };
  }
  return { error: message, code: err.code };
}
