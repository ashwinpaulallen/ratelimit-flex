import type { RequestHandler } from 'express';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import {
  formatRateLimitHeaders,
  type HeaderInput,
  resolveHeaderConfig,
} from '../headers/index.js';
import { MetricsManager } from '../metrics/manager.js';
import {
  RateLimitEngine,
  defaultKeyGenerator,
  matchingDecrementOptions,
  resolveIncrementOpts,
} from '../strategies/rate-limit-engine.js';
import type { KeyManager } from '../key-manager/KeyManager.js';
import type { InMemoryShield } from '../shield/InMemoryShield.js';
import type {
  RateLimitConsumeResult,
  RateLimitInfo,
  RateLimitOptions,
  WindowRateLimitOptions,
} from '../types/index.js';
import type { MetricsSnapshot } from '../types/metrics.js';
import { warnIfMemoryStoreInCluster, warnIfRedisStoreWithoutInsurance } from '../utils/environment.js';
import {
  jsonErrorBody,
  keyManagerBlockedJson,
  keyManagerRetryAfterSeconds,
  mergeRateLimiterOptions,
  resolveStoreWithInMemoryShield,
  toRateLimitInfo,
} from './merge-options.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * When {@link RateLimitOptionsBase.keyManager} is set, or auto-created from `penaltyBox`.
     * @since 2.2.0
     */
    keyManager?: KeyManager;
    /**
     * When {@link RateLimitOptions.metrics} is enabled: orchestrator for snapshots, history, Prometheus, and `on('metrics')`.
     * @since 1.3.0
     */
    rateLimitMetrics?: MetricsManager;
    /**
     * When metrics are enabled: same as {@link MetricsManager.getSnapshot} (null before the first tick).
     * @since 1.3.0
     */
    getMetricsSnapshot?: () => MetricsSnapshot | null;
    /**
     * When metrics are enabled: same as {@link MetricsManager.getHistory}.
     * @since 1.3.0
     */
    getMetricsHistory?: () => MetricsSnapshot[];
    /**
     * When `metrics.prometheus.enabled` is true: Express-style `GET` handler for Prometheus text. `undefined` otherwise.
     * @since 1.3.0
     */
    metricsEndpoint?: RequestHandler;
    /**
     * When `metrics.prometheus.enabled` is true: native Fastify handler for `GET /metrics` (no Express). `undefined` otherwise.
     * @since 1.3.0
     */
    fastifyMetricsRoute?: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
    /**
     * When {@link RateLimitOptionsBase.inMemoryBlock} wrapped the backing store with {@link InMemoryShield}.
     * @since 2.3.0
     */
    rateLimitShield: InMemoryShield | null;
  }

  interface FastifyRequest {
    /**
     * @description Snapshot after a successful consume. Set by {@link fastifyRateLimiter}.
     * @default undefined
     */
    rateLimit?: RateLimitInfo;
    /**
     * @description When the backing store is a {@link ComposedStore}, the last consume result including per-layer `layers`.
     * @default undefined
     * @since 2.0.0
     */
    rateLimitComposed?: RateLimitConsumeResult;
    /**
     * @description Internal: key for optional decrement on `onResponse`.
     * @default undefined
     */
    rateLimitKey?: string;
    /**
     * @description Internal: which response outcomes trigger {@link RateLimitStore.decrement} with the same **`cost`** as the consume (see `incrementCost` / {@link resolveIncrementOpts}).
     */
    rateLimitDecrementFlags?: {
      /** @description Decrement when HTTP status is 400 or greater. */
      onFailed: boolean;
      /** @description Decrement when HTTP status is less than 400. */
      onSuccess: boolean;
    };
  }
}

function applyHeaderMap(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
  }
}

function decrementStores(resolved: RateLimitOptions, key: string, req: unknown): void {
  const incOpts = resolveIncrementOpts(resolved, req);
  const decOpts = matchingDecrementOptions(incOpts);
  const w = resolved as WindowRateLimitOptions;
  if (w.groupedWindowStores && w.groupedWindowStores.length > 0) {
    for (const g of w.groupedWindowStores) {
      void g.store.decrement(key, decOpts).catch(() => {
        /* ignore */
      });
    }
    return;
  }
  void resolved.store.decrement(key, decOpts).catch(() => {
    /* ignore */
  });
}

const plugin: FastifyPluginAsync<Partial<RateLimitOptions>> = async (fastify, options) => {
  const merged = mergeRateLimiterOptions(options);
  const { optionsForEngine: resolved, shield } = resolveStoreWithInMemoryShield(merged);
  warnIfMemoryStoreInCluster(resolved.store);
  warnIfRedisStoreWithoutInsurance(resolved.store);
  const metricsManager = new MetricsManager(resolved.metrics, shield);
  const { onLimitReached, ...engineOptions } = resolved;
  const engine = new RateLimitEngine(engineOptions, metricsManager.getCounters() ?? undefined);
  const keyGen = resolved.keyGenerator ?? defaultKeyGenerator;

  let metricsCollectorStarted = false;

  if (resolved.keyManager !== undefined) {
    fastify.decorate('keyManager', resolved.keyManager);
  }

  fastify.decorate('rateLimitShield', shield);

  if (metricsManager.isEnabled()) {
    fastify.decorate('rateLimitMetrics', metricsManager);
    fastify.decorate('getMetricsSnapshot', () => metricsManager.getSnapshot());
    fastify.decorate('getMetricsHistory', () => metricsManager.getHistory());
    fastify.decorate('metricsEndpoint', metricsManager.getPrometheusMiddleware() ?? undefined);
    const fastifyMetricsRoute = metricsManager.getPrometheusFastifyHandler();
    if (fastifyMetricsRoute !== null) {
      fastify.decorate('fastifyMetricsRoute', fastifyMetricsRoute);
    }
    fastify.addHook('onClose', async () => {
      await metricsManager.shutdown();
    });
  }

  fastify.addHook('onRequest', async (request, reply) => {
    if (!metricsCollectorStarted && metricsManager.getCounters()) {
      metricsManager.start();
      metricsCollectorStarted = true;
    }

    try {
      const key = keyGen(request);
      const result = await engine.consumeWithKey(key, request);

      if (result.layers) {
        request.rateLimitComposed = result;
      }

      if (result.storeUnavailable === true) {
        reply.header('X-RateLimit-Store', 'fallback');
      }

      const headerCfg = resolveHeaderConfig(resolved, request, result.bindingSlotIndex);
      if (headerCfg.format) {
        const headerInput: HeaderInput = {
          limit: headerCfg.resolvedLimit,
          remaining: result.remaining,
          resetTime: result.resetTime,
          isBlocked: result.isBlocked,
          windowMs: headerCfg.resolvedWindowMs,
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

      if (result.isBlocked) {
        // 503 first: Redis fail-closed. Blocklist/penalty never reach the store (engine order), so they
        // cannot collide with storeUnavailable on the same response.
        if (result.storeUnavailable || result.blockReason === 'service_unavailable') {
          await reply.status(503).send(jsonErrorBody('Service temporarily unavailable'));
          return;
        }
        if (result.blockReason === 'key_manager' && resolved.keyManager) {
          const status = resolved.statusCode ?? 429;
          const ra = keyManagerRetryAfterSeconds(resolved, key);
          if (ra !== undefined) {
            reply.header('Retry-After', String(ra));
          }
          await reply.status(status).send(keyManagerBlockedJson(resolved, key));
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
      decrementStores(resolved, key, request);
    }
  });
};

/**
 * Fastify plugin (`fastify-plugin`): rate limiting via `onRequest` / `onResponse` hooks.
 *
 * @description Same semantics as {@link expressRateLimiter} (including `metrics`, snapshots, Prometheus / OTel when configured, and **`X-RateLimit-Store: fallback`** when {@link RateLimitResult.storeUnavailable} is true). Import from `ratelimit-flex/fastify` to avoid pulling Fastify into Express-only bundles.
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
