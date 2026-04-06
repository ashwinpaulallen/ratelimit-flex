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
