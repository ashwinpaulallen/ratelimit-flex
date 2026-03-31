/**
 * **Fastify entry** — re-exports {@link fastifyRateLimiter} only.
 *
 * @description Import from `ratelimit-flex/fastify` so Express-only apps do not pull `fastify` / `fastify-plugin` from the main bundle.
 * @see {@link fastifyRateLimiter}
 * @since 1.0.0
 */
export { fastifyRateLimiter } from './middleware/fastify.js';
