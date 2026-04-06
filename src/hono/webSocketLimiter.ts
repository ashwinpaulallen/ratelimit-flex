import type { MiddlewareHandler } from 'hono';
import { rateLimiter, type HonoRateLimitOptions } from './rateLimiter.js';

/**
 * Rate limit **WebSocket upgrade** requests (HTTP GET/HEAD before `upgradeWebSocket`).
 *
 * @remarks
 * This is the same implementation as {@link rateLimiter} — use it on routes that call
 * `upgradeWebSocket` so limits run **before** the upgrade. Allowed requests call `next()` and
 * receive normal rate-limit headers on the HTTP response; rejected requests return **429** (or your
 * configured status) with JSON and never reach the WebSocket handler.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono';
 * import { upgradeWebSocket } from 'hono/cloudflare-workers';
 * import { webSocketLimiter } from 'ratelimit-flex/hono';
 *
 * const app = new Hono();
 * app.get(
 *   '/ws',
 *   webSocketLimiter({
 *     maxRequests: 10,
 *     windowMs: 60_000,
 *     keyGenerator: (c) => c.req.header('x-api-key') ?? 'anon',
 *   }),
 *   upgradeWebSocket(() => ({
 *     onMessage(event, ws) {
 *       ws.send('pong');
 *     },
 *   })),
 * );
 * ```
 */
export function webSocketLimiter(options: HonoRateLimitOptions = {}): MiddlewareHandler {
  return rateLimiter(options);
}
