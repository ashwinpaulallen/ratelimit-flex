/**
 * Fastify integration — import from `ratelimit-flex/fastify` so Express-only apps
 * do not resolve `fastify` or `fastify-plugin` from the main package entry.
 */
export { fastifyRateLimiter } from './middleware/fastify.js';
