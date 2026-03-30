import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { RateLimitEngine, defaultKeyGenerator } from '../strategies/rate-limit-engine.js';
import type { RateLimitInfo, RateLimitOptions, WindowRateLimitOptions } from '../types/index.js';
import { jsonErrorBody, mergeRateLimiterOptions, toRateLimitInfo } from './merge-options.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by {@link fastifyRateLimiter} after a successful consume (not blocked). */
    rateLimit?: RateLimitInfo;
    /** Internal: storage key for optional response-based decrement. */
    rateLimitKey?: string;
    /** Internal: when to consider decrement on `onResponse`. */
    rateLimitDecrementFlags?: {
      onFailed: boolean;
      onSuccess: boolean;
    };
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

const plugin: FastifyPluginAsync<Partial<RateLimitOptions>> = async (fastify, options) => {
  const resolved = mergeRateLimiterOptions(options);
  const { onLimitReached, ...engineOptions } = resolved;
  const engine = new RateLimitEngine(engineOptions);
  const keyGen = resolved.keyGenerator ?? defaultKeyGenerator;

  fastify.addHook('onRequest', async (request, reply) => {
    if (resolved.skip?.(request) === true) {
      return;
    }

    const key = keyGen(request);
    const result = await engine.consumeWithKey(key, request);

    if (resolved.headers !== false) {
      for (const [name, value] of Object.entries(result.headers)) {
        reply.header(name, value);
      }
    }

    if (result.isBlocked) {
      // 503 first: Redis fail-closed. Blocklist/penalty never reach the store (engine order), so they
      // cannot collide with storeUnavailable on the same response.
      if (result.storeUnavailable || result.blockReason === 'service_unavailable') {
        await reply.status(503).send(jsonErrorBody('Service temporarily unavailable'));
        return;
      }
      if (onLimitReached && result.blockReason === 'rate_limit') {
        await Promise.resolve(onLimitReached(request, result));
      }
      const status =
        result.blockReason === 'blocklist'
          ? (resolved.blocklistStatusCode ?? 403)
          : (resolved.statusCode ?? 429);
      const msg =
        result.blockReason === 'blocklist'
          ? (resolved.blocklistMessage ?? 'Forbidden')
          : (resolved.message ?? 'Too many requests');
      await reply.status(status).send(jsonErrorBody(msg));
      return;
    }

    request.rateLimit = toRateLimitInfo(resolved, result, request);

    const onFailed = resolved.skipFailedRequests === true;
    const onSuccess = resolved.skipSuccessfulRequests === true;
    if (onFailed || onSuccess) {
      request.rateLimitKey = key;
      request.rateLimitDecrementFlags = { onFailed, onSuccess };
    }
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const key = request.rateLimitKey;
    const flags = request.rateLimitDecrementFlags;
    if (!key || !flags) {
      return;
    }

    const status = reply.statusCode;
    const failed = status >= 400;
    const success = status < 400;

    if ((flags.onFailed && failed) || (flags.onSuccess && success)) {
      decrementStores(resolved, key);
    }
  });
};

/**
 * Fastify plugin (wrapped with `fastify-plugin` for correct encapsulation).
 * Registers `onRequest` / `onResponse` hooks; one {@link RateLimitEngine} and store per registration.
 */
export const fastifyRateLimiter = fp(plugin, {
  name: 'ratelimit-flex',
});
