/**
 * **Fastify entry** — {@link fastifyRateLimiter} and {@link fastifyQueuedRateLimiter}.
 *
 * @description Import from `ratelimit-flex/fastify` so Express-only apps do not pull `fastify` / `fastify-plugin` from the main bundle.
 * @see {@link fastifyRateLimiter}
 * @see {@link fastifyQueuedRateLimiter}
 * @since 1.0.0
 */
export { fastifyRateLimiter } from './middleware/fastify.js';
export { fastifyQueuedRateLimiter } from './middleware/fastifyQueuedRateLimiter.js';
export type { QueuedRateLimiterOptions } from './middleware/expressQueuedRateLimiter.js';

/**
 * Fastify plugin: same KeyManager admin routes as `createAdminRouter` from the main package entry.
 *
 * @since 2.2.0
 */
export { createFastifyAdminPlugin, type FastifyAdminPluginOptions } from './key-manager/admin-fastify.js';
