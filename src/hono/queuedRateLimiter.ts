import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  formatRateLimitHeaders,
  type HeaderInput,
  resolveHeaderConfig,
  resolveWindowMsForHeaders,
} from '../headers/index.js';
import { RateLimiterQueue, RateLimiterQueueError } from '../queue/RateLimiterQueue.js';
import { retryAfterSeconds } from '../queue/queue-middleware-utils.js';
import { honoDefaultKeyGenerator, type HonoRateLimitOptions } from './rateLimiter.js';
import { RateLimitStrategy, type RateLimitOptions } from '../types/index.js';
import { getLimit, jsonErrorBody, mergeRateLimiterOptions, resolveStoreWithInMemoryShield } from '../middleware/merge-options.js';
import { warnIfMemoryStoreInCluster, warnIfRedisStoreWithoutInsurance } from '../utils/environment.js';

/**
 * Helper to cast numeric status codes to Hono's ContentfulStatusCode type.
 * @internal
 */
function toContentfulStatus(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

export interface HonoQueuedRateLimitOptions extends HonoRateLimitOptions {
  /** Max waiting requests (default: 100, same as Express queued). */
  maxQueueSize?: number;
  /** Max time to wait for capacity in ms (default: 30_000). */
  maxQueueTimeMs?: number;
  /** Prefix for internal queue keys (default: `rlf-queued`). */
  keyPrefix?: string;
}

export type HonoQueuedRateLimiterHandler = MiddlewareHandler & { queue: RateLimiterQueue };

async function resolveHonoCost(c: Context, h: HonoQueuedRateLimitOptions): Promise<number> {
  if (h.cost === undefined) {
    return 1;
  }
  if (typeof h.cost === 'number') {
    return h.cost;
  }
  return await Promise.resolve(h.cost(c));
}

/**
 * Hono middleware that **waits** for capacity via {@link RateLimiterQueue} (same semantics as
 * {@link expressQueuedRateLimiter}).
 *
 * @remarks
 * Head-of-line blocking applies to the shared FIFO queue — see {@link RateLimiterQueue}.
 */
export function queuedRateLimiter(options: HonoQueuedRateLimitOptions = {}): HonoQueuedRateLimiterHandler {
  const merged = mergeRateLimiterOptions({
    strategy: options.strategy ?? RateLimitStrategy.SLIDING_WINDOW,
    windowMs: options.windowMs ?? 60_000,
    maxRequests: options.maxRequests ?? 100,
    store: options.store,
    standardHeaders: options.standardHeaders ?? true,
    legacyHeaders: options.legacyHeaders ?? false,
    identifier: options.identifier,
    allowlist: options.allowlist,
    blocklist: options.blocklist,
    inMemoryBlock: options.inMemoryBlock,
  } satisfies Partial<RateLimitOptions>);

  const { optionsForEngine: resolved } = resolveStoreWithInMemoryShield(merged);
  warnIfMemoryStoreInCluster(resolved.store);
  warnIfRedisStoreWithoutInsurance(resolved.store);

  const windowMsForQueue =
    resolved.strategy === RateLimitStrategy.TOKEN_BUCKET
      ? (resolved.interval ?? 60_000)
      : (resolved.windowMs ?? 60_000);
  const maxCap = getLimit(resolved, undefined);

  const maxQueueSize = options.maxQueueSize ?? 100;
  const maxQueueTimeMs = options.maxQueueTimeMs ?? 30_000;

  const queue = new RateLimiterQueue(
    resolved.store,
    {
      windowMs: windowMsForQueue,
      maxRequests: maxCap,
      keyPrefix: options.keyPrefix ?? 'rlf-queued',
      strategy: resolved.strategy,
    },
    { maxQueueSize, maxQueueTimeMs },
  );

  const keyFromContext = options.keyGenerator ?? honoDefaultKeyGenerator;
  const rejectStatus = options.statusCode ?? 429;

  const fn: MiddlewareHandler = async (c, next) => {
    if (options.skip !== undefined) {
      const s = await Promise.resolve(options.skip(c));
      if (s === true) {
        return next();
      }
    }

    const key = await Promise.resolve(keyFromContext(c));

    if (options.allowlist?.includes(key)) {
      return next();
    }
    if (options.blocklist?.includes(key)) {
      const msg = resolved.blocklistMessage ?? 'Forbidden';
      return c.json(jsonErrorBody(msg), toContentfulStatus(resolved.blocklistStatusCode ?? 403));
    }

    const cost = await resolveHonoCost(c, options);

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
        for (const [name, value] of Object.entries(headers)) {
          c.header(name, value);
        }
        if (legacyHeaders) {
          for (const [name, value] of Object.entries(legacyHeaders)) {
            c.header(name, value);
          }
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
        const retrySec = retryAfterSeconds(err, maxQueueTimeMs);
        c.header('Retry-After', String(retrySec));
        const m = options.message;
        const payload: string | object =
          m === undefined || typeof m === 'function' ? err.message : m;
        return c.json(jsonErrorBody(payload), toContentfulStatus(rejectStatus));
      }
      throw err;
    }
  };

  return Object.assign(fn, { queue }) as HonoQueuedRateLimiterHandler;
}
