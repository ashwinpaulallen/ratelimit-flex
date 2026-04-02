import type { RateLimitOptions } from '../types/index.js';

/**
 * Subset of `express-rate-limit` options commonly used when migrating.
 */
export type ExpressRateLimitLikeOptions = {
  standardHeaders?: boolean | 'draft-6' | 'draft-7' | 'draft-8';
  legacyHeaders?: boolean;
  windowMs?: number;
  max?: number;
  [key: string]: unknown;
};

/**
 * Maps express-rate-limit's `standardHeaders` option values to ratelimit-flex equivalents.
 * Useful for migration.
 *
 * express-rate-limit uses: `true` | `false` | `'draft-6'` | `'draft-7'` | `'draft-8'`
 * ratelimit-flex: **`true` → `'draft-6'`**, **`false` → `false`** (no rate-limit headers), omitted → **`'legacy'`**, draft strings pass through.
 * Also maps **`legacyHeaders`** and **`max` → `maxRequests`**.
 *
 * @param opts - Options shaped like express-rate-limit’s rate limit config (`max`, `windowMs`, header flags).
 * @returns Partial {@link RateLimitOptions} to spread into middleware.
 * @since 1.4.0
 */
export function fromExpressRateLimitOptions(opts: ExpressRateLimitLikeOptions): Partial<RateLimitOptions> {
  const standardHeaders =
    opts.standardHeaders === true
      ? 'draft-6'
      : opts.standardHeaders === false
        ? false
        : opts.standardHeaders ?? 'legacy';

  return {
    windowMs: opts.windowMs,
    maxRequests: opts.max,
    standardHeaders,
    legacyHeaders: opts.legacyHeaders ?? (opts.standardHeaders ? false : true),
  };
}
