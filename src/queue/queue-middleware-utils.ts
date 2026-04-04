/**
 * Shared utilities for queued rate limiting middleware (Express and Fastify).
 * 
 * @internal
 * @since 1.5.0
 */

import { sanitizeIncrementCost } from '../utils/clamp.js';
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
