import { getLimit } from '../middleware/merge-options.js';
import type { RateLimitOptions, WindowRateLimitOptions } from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { sanitizeWindowMs } from '../utils/clamp.js';
import { defaultRateLimitIdentifier, type HeaderFormat } from './formatHeaders.js';

/**
 * Output of {@link resolveHeaderConfig}: profile, identifier, and the same resolved limit / window used for {@link formatRateLimitHeaders} (avoids duplicate {@link getLimit} / {@link resolveWindowMsForHeaders} calls in middleware).
 *
 * @since 1.4.0
 */
export interface ResolvedHeaderConfig {
  format: HeaderFormat | false;
  includeLegacy: boolean;
  identifier: string;
  /** Same value as {@link getLimit} with the same `bindingSlotIndex`. */
  resolvedLimit: number;
  /** Same value as {@link resolveWindowMsForHeaders} with the same `bindingSlotIndex`. */
  resolvedWindowMs: number;
}

/**
 * Window length for {@link formatRateLimitHeaders} / policy strings (token bucket uses `interval`).
 *
 * @remarks
 * **Grouped windows** (`limits` / `groupedWindowStores`): when **`bindingSlotIndex`** is set and points at an existing slot, returns that slot’s `windowMs` (aligned with {@link getLimit} for the same index). When **`bindingSlotIndex`** is unavailable or out of range, returns the **shortest** `windowMs` among slots and **`getLimit`** uses the **minimum** `maxRequests` across slots — policy headers (`w=`, default {@link defaultRateLimitIdentifier}, draft `RateLimit-Policy`) then describe a **single-window-style** quota, not the full multi-window rule (e.g. 100/min + 1000/hour may show `w=60` with a limit from the tightest cap). That approximation applies only without a binding slot; set **`identifier`** explicitly if clients need a clearer policy name when unbound.
 * @param bindingSlotIndex - Optional index from the consume result’s `bindingSlotIndex` (grouped windows).
 * @since 1.4.0
 */
export function resolveWindowMsForHeaders(opts: RateLimitOptions, bindingSlotIndex?: number): number {
  if (opts.strategy === RateLimitStrategy.TOKEN_BUCKET) {
    return opts.interval ?? 60_000;
  }
  const w = opts as WindowRateLimitOptions;
  if (w.limits && w.limits.length > 0) {
    if (bindingSlotIndex !== undefined) {
      const slot = w.limits[bindingSlotIndex];
      if (slot !== undefined) {
        return sanitizeWindowMs(slot.windowMs, 60_000);
      }
    }
    return Math.min(...w.limits.map((e) => sanitizeWindowMs(e.windowMs, 60_000)));
  }
  if (w.groupedWindowStores && w.groupedWindowStores.length > 0) {
    const grouped = w.groupedWindowStores;
    if (bindingSlotIndex !== undefined) {
      const slot = grouped[bindingSlotIndex];
      if (slot !== undefined) {
        return slot.windowMs;
      }
    }
    return Math.min(...grouped.map((g) => g.windowMs));
  }
  return w.windowMs ?? 60_000;
}

/**
 * Resolves which header profile to emit, whether to add legacy `X-RateLimit-*` alongside drafts, and the policy **`identifier`** string.
 *
 * @description Pass **`req`** when {@link RateLimitOptionsBase.maxRequests} is a function so the default identifier uses the resolved limit. Omit **`req`** only when the limit does not depend on the request (same identifier for all requests).
 * @param options - Merged {@link RateLimitOptions} (or partial; cast internally for {@link getLimit}).
 * @param req - Framework request for dynamic caps / identifiers.
 * @param bindingSlotIndex - Optional index from consume result (grouped windows); forwarded to {@link resolveWindowMsForHeaders} and {@link getLimit} for policy / identifier alignment.
 * @since 1.4.0
 */
export function resolveHeaderConfig(
  options: Partial<RateLimitOptions>,
  req?: unknown,
  bindingSlotIndex?: number,
): ResolvedHeaderConfig {
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

  const resolvedWindowMs = resolveWindowMsForHeaders(o, bindingSlotIndex);
  const resolvedLimit = getLimit(o, req, bindingSlotIndex);
  const identifier = o.identifier ?? defaultRateLimitIdentifier(resolvedLimit, resolvedWindowMs);

  return { format, includeLegacy, identifier, resolvedLimit, resolvedWindowMs };
}
