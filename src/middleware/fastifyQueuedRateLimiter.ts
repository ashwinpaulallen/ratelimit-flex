import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

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
import type { QueuedRateLimiterOptions } from './expressQueuedRateLimiter.js';

export type { QueuedRateLimiterOptions } from './expressQueuedRateLimiter.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The {@link RateLimiterQueue} used by {@link fastifyQueuedRateLimiter} (inspect, `clear()`, `shutdown()`, etc.). */
    rateLimitQueue?: RateLimiterQueue;
  }
}

function applyHeaderMap(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
  }
}

const plugin: FastifyPluginAsync<QueuedRateLimiterOptions> = async (fastify, options) => {
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

  fastify.decorate('rateLimitQueue', queue);

  fastify.addHook('onClose', async () => {
    queue.shutdown();
  });

  const keyGen = options.keyGenerator ?? defaultKeyGenerator;
  const statusCode = options.statusCode ?? 429;

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    let key: string;
    try {
      key = keyGen(request);
    } catch (err) {
      return reply.send(err);
    }

    const cost = resolveCost(request, options.incrementCost);

    try {
      const result = await queue.removeTokens(key, cost);

      const headerCfg = resolveHeaderConfig(merged, request);
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
        applyHeaderMap(reply, headers);
        if (legacyHeaders) {
          applyHeaderMap(reply, legacyHeaders);
        }
      }

      const limit = getLimit(merged, request);
      request.rateLimit = {
        limit,
        remaining: result.remaining,
        resetTime: result.resetTime,
        current: Math.max(0, limit - result.remaining),
      };
    } catch (err: unknown) {
      if (err instanceof RateLimiterQueueError) {
        const retrySec = retryAfterSeconds(err, maxQueueTimeMs);
        const body = options.message ?? err.message;
        await reply.code(statusCode).header('Retry-After', String(retrySec)).send(jsonErrorBody(body));
        return;
      }
      return reply.send(err);
    }
  });
};

/**
 * Fastify plugin (`fastify-plugin`): same behavior as {@link expressQueuedRateLimiter} — waits for capacity via
 * {@link RateLimiterQueue} instead of responding with 429 as soon as the window is full.
 * 
 * **Head-of-line blocking:** The queue is a single FIFO array. When a request for key "A" is blocked
 * (waiting for capacity), all subsequent requests for key "B" also wait, even if "B" has capacity.
 * This is typically fine for HTTP middleware (one queue per route), but be aware if using custom
 * `keyGenerator` with many different keys.
 *
 * @description Registers `onRequest` and decorates the instance with **`rateLimitQueue`**. Import from `ratelimit-flex/fastify`.
 * @see {@link expressQueuedRateLimiter}
 * @see {@link RateLimiterQueueOptions} for head-of-line blocking details
 * @since 1.4.2
 */
export const fastifyQueuedRateLimiter = fp(plugin, {
  name: 'ratelimit-flex-queued',
});
