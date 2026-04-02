import { getLimit } from '../middleware/merge-options.js';
import type { RateLimitOptions, WindowRateLimitOptions } from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { defaultRateLimitIdentifier, type HeaderFormat } from './formatHeaders.js';

/**
 * Window length for {@link formatRateLimitHeaders} / policy strings (token bucket uses `interval`).
 *
 * @remarks
 * **Grouped windows** (`limits` / `groupedWindowStores`): returns the **shortest** `windowMs` among slots. **`getLimit`** uses the **minimum** `maxRequests` across slots. Policy headers (`w=`, default {@link defaultRateLimitIdentifier}, draft `RateLimit-Policy`) therefore describe a **single-window-style** quota, not the full multi-window rule (e.g. 100/min + 1000/hour may show `w=60` with a limit from the tightest cap). That is a deliberate approximation; set **`identifier`** explicitly if clients need a clearer policy name.
 * @since 1.4.0
 */
export function resolveWindowMsForHeaders(opts: RateLimitOptions): number {
  if (opts.strategy === RateLimitStrategy.TOKEN_BUCKET) {
    return opts.interval ?? 60_000;
  }
  const w = opts as WindowRateLimitOptions;
  if (w.groupedWindowStores && w.groupedWindowStores.length > 0) {
    return Math.min(...w.groupedWindowStores.map((g) => g.windowMs));
  }
  return w.windowMs ?? 60_000;
}

/**
 * Resolves which header profile to emit, whether to add legacy `X-RateLimit-*` alongside drafts, and the policy **`identifier`** string.
 *
 * @description Pass **`req`** when {@link RateLimitOptionsBase.maxRequests} is a function so the default identifier uses the resolved limit. Omit **`req`** only when the limit does not depend on the request (same identifier for all requests).
 * @param options - Merged {@link RateLimitOptions} (or partial; cast internally for {@link getLimit}).
 * @param req - Framework request for dynamic caps / identifiers.
 * @since 1.4.0
 */
export function resolveHeaderConfig(
  options: Partial<RateLimitOptions>,
  req?: unknown,
): {
  format: HeaderFormat | false;
  includeLegacy: boolean;
  identifier: string;
} {
  const o = options as RateLimitOptions;
  let format: HeaderFormat | false;
  let includeLegacy: boolean;

  if (o.standardHeaders !== undefined) {
    if (o.standardHeaders === true) {
      format = 'legacy';
      includeLegacy = true;
    } else if (o.standardHeaders === false) {
      format = false;
      includeLegacy = false;
    } else {
      format = o.standardHeaders;
      includeLegacy = o.legacyHeaders ?? false;
    }
  } else if (o.headers !== undefined) {
    format = o.headers ? 'legacy' : false;
    includeLegacy = !!o.headers;
  } else {
    format = 'legacy';
    includeLegacy = true;
  }

  const resolvedWindowMs = resolveWindowMsForHeaders(o);
  const resolvedMax = getLimit(o, req);
  const identifier = o.identifier ?? defaultRateLimitIdentifier(resolvedMax, resolvedWindowMs);

  return { format, includeLegacy, identifier };
}
