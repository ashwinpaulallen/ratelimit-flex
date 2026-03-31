import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { RateLimitEngine, defaultKeyGenerator } from '../strategies/rate-limit-engine.js';
import type { RateLimitInfo, RateLimitOptions, WindowRateLimitOptions } from '../types/index.js';
import { warnIfMemoryStoreInCluster } from '../utils/environment.js';
import { jsonErrorBody, mergeRateLimiterOptions, toRateLimitInfo } from './merge-options.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * @description Snapshot after a successful consume. Set by {@link fastifyRateLimiter}.
     * @default undefined
     */
    rateLimit?: RateLimitInfo;
    /**
     * @description Internal: key for optional decrement on `onResponse`.
     * @default undefined
     */
    rateLimitKey?: string;
    /**
     * @description Internal: which response outcomes trigger {@link RateLimitStore.decrement}.
     */
    rateLimitDecrementFlags?: {
      /** @description Decrement when HTTP status is 400 or greater. */
      onFailed: boolean;
      /** @description Decrement when HTTP status is less than 400. */
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
  warnIfMemoryStoreInCluster(resolved.store);
  const { onLimitReached, ...engineOptions } = resolved;
  const engine = new RateLimitEngine(engineOptions);
  const keyGen = resolved.keyGenerator ?? defaultKeyGenerator;

  fastify.addHook('onRequest', async (request, reply) => {
    if (resolved.skip?.(request) === true) {
      return;
    }

    try {
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
    } catch (err) {
      return reply.send(err);
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
 * Fastify plugin (`fastify-plugin`): rate limiting via `onRequest` / `onResponse` hooks.
 *
 * @description Same semantics as {@link expressRateLimiter}; import from `ratelimit-flex/fastify` to avoid pulling Fastify into Express-only bundles.
 * @param options - Partial {@link RateLimitOptions} (merged with defaults inside the plugin).
 * @throws Errors from `keyGenerator`, `consumeWithKey`, or `onLimitReached` are passed to the Fastify error pipeline (`reply.send(err)`), matching Express `next(err)`.
 * @example
 * ```ts
 * import Fastify from 'fastify';
 * import { fastifyRateLimiter } from 'ratelimit-flex/fastify';
 *
 * const app = Fastify();
 * await app.register(fastifyRateLimiter, { maxRequests: 100, windowMs: 60_000 });
 * ```
 * @see {@link expressRateLimiter}
 * @see {@link RateLimitEngine}
 * @since 1.0.0
 */
export const fastifyRateLimiter = fp(plugin, {
  name: 'ratelimit-flex',
});
