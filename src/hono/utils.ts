import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Cast numeric status codes to Hono's `ContentfulStatusCode` type.
 * @internal
 */
export function toContentfulStatus(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

/**
 * Apply a map of header names/values to the Hono context.
 * @internal
 */
export function applyHeadersToContext(c: Context, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    c.header(name, value);
  }
}

/**
 * HTTP status for `skipFailedRequests` / `skipSuccessfulRequests` after `await next()`.
 *
 * If **`c.res`** is missing or **`c.res.status`** is **0**, non-finite, or outside **100–599** (some runtimes
 * leave a sentinel), returns **200** so rollback matches typical “successful handler” semantics — in particular
 * **`0 < 400`** must not wrongly fire **`skipSuccessfulRequests`** rollback.
 *
 * Exported from **`ratelimit-flex/hono`** for custom middleware that mirrors the same rule.
 *
 * @since 3.0.0
 */
export function resolvedHonoRollbackStatus(c: Context): number {
  const s = c.res?.status;
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 100 || s > 599) {
    return 200;
  }
  return Math.trunc(s);
}
