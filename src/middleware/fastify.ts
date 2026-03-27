import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { RateLimitEngine, defaultKeyGenerator } from '../strategies/rate-limit-engine.js';
import type { RateLimitInfo, RateLimitOptions } from '../types/index.js';
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
      if (onLimitReached) {
        await Promise.resolve(onLimitReached(request, result));
      }
      await reply
        .status(resolved.statusCode ?? 429)
        .send(jsonErrorBody(resolved.message ?? 'Too many requests'));
      return;
    }

    request.rateLimit = toRateLimitInfo(resolved, result);

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
      void resolved.store.decrement(key).catch(() => {
        /* ignore */
      });
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
