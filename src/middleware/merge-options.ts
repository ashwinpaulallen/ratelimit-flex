import type { ComposedStore } from '../composition/ComposedStore.js';
import { compose } from '../composition/compose.js';
import { KeyManager } from '../key-manager/KeyManager.js';
import { MemoryStore } from '../stores/memory-store.js';
import { sanitizeRateLimitCap, sanitizeWindowMs } from '../utils/clamp.js';
import {
  fixedWindowDefaults,
  slidingWindowDefaults,
  tokenBucketDefaults,
} from '../strategies/defaults.js';
import type {
  RateLimitInfo,
  RateLimitOptions,
  RateLimitResult,
  TokenBucketRateLimitOptions,
  WindowLimitSpec,
  WindowRateLimitOptions,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { validateRateLimitHeaderOptions } from './validate-header-options.js';

export const baseDefaults = {
  headers: true,
  statusCode: 429,
  message: 'Too many requests',
  skipFailedRequests: false,
  skipSuccessfulRequests: false,
} as const;

/**
 * Builds a multi-window {@link ComposedStore} from `limits` (one {@link MemoryStore} per slot, `compose.all` semantics).
 * Same as {@link compose.windows} with the given strategy.
 */
export function limitsToComposedStore(
  strategy: RateLimitStrategy.SLIDING_WINDOW | RateLimitStrategy.FIXED_WINDOW,
  slots: ReadonlyArray<{ windowMs: number; maxRequests: number }>,
): ComposedStore {
  return compose.windows(
    ...slots.map((s) => ({
      windowMs: s.windowMs,
      maxRequests: s.maxRequests,
      strategy,
    })),
  );
}

/**
 * Resolves the effective limit for headers and `req.rateLimit` / `request.rateLimit`.
 *
 * @remarks
 * **Grouped windows:** when **`bindingSlotIndex`** selects an existing slot, returns that slot’s `maxRequests`. Otherwise uses the **minimum** `maxRequests` across slots (same approximation as {@link resolveWindowMsForHeaders} when unbound).
 */
export function getLimit(opts: RateLimitOptions, req?: unknown, bindingSlotIndex?: number): number {
  if (opts.strategy === RateLimitStrategy.TOKEN_BUCKET) {
    return opts.bucketSize;
  }
  const w = opts as WindowRateLimitOptions;
  if (w.limits && w.limits.length > 0) {
    if (bindingSlotIndex !== undefined) {
      const slot = w.limits[bindingSlotIndex];
      if (slot !== undefined) {
        return sanitizeRateLimitCap(slot.max, 100);
      }
    }
    return Math.min(...w.limits.map((e) => sanitizeRateLimitCap(e.max, 100)));
  }
  if (w.groupedWindowStores && w.groupedWindowStores.length > 0) {
    const grouped = w.groupedWindowStores;
    if (bindingSlotIndex !== undefined) {
      const slot = grouped[bindingSlotIndex];
      if (slot !== undefined) {
        return slot.maxRequests;
      }
    }
    return Math.min(...grouped.map((g) => g.maxRequests));
  }
  const mr = w.maxRequests ?? 100;
  if (typeof mr === 'function') {
    return req !== undefined ? sanitizeRateLimitCap(mr(req), 100) : 100;
  }
  return sanitizeRateLimitCap(mr, 100);
}

/**
 * Merge partial options with strategy defaults and ensure a {@link MemoryStore} when `store` is omitted.
 */
function attachKeyManagerFromPenaltyBox(merged: RateLimitOptions): RateLimitOptions {
  if (!merged.penaltyBox || merged.keyManager !== undefined) {
    return merged;
  }
  const windowMs =
    merged.strategy === RateLimitStrategy.TOKEN_BUCKET
      ? (merged as TokenBucketRateLimitOptions).interval
      : sanitizeWindowMs((merged as WindowRateLimitOptions).windowMs, 60_000);
  const km = new KeyManager({
    store: merged.store,
    maxRequests: getLimit(merged),
    windowMs,
    penaltyBlockThreshold: merged.penaltyBox.violationsThreshold,
    penaltyBlockDurationMs: merged.penaltyBox.penaltyDurationMs,
  });
  return { ...merged, keyManager: km };
}

/**
 * JSON body when {@link RateLimitOptionsBase.keyManager} blocks a request before the store increment.
 *
 * @since 2.2.0
 */
export function keyManagerBlockedJson(resolved: RateLimitOptions, key: string): object {
  const km = resolved.keyManager!;
  const msg = resolved.message ?? 'Too many requests';
  const base = typeof msg === 'string' ? { error: msg } : { ...(msg as object) };
  const info = km.getBlockInfo(key);
  return {
    ...base,
    blocked: true,
    reason: info?.reason.type ?? 'manual',
    expiresAt: info?.expiresAt?.toISOString() ?? null,
  };
}

/**
 * `Retry-After` value in seconds when the manual block has a finite {@link KeyManager} expiry.
 *
 * @since 2.2.0
 */
export function keyManagerRetryAfterSeconds(resolved: RateLimitOptions, key: string): number | undefined {
  const km = resolved.keyManager;
  if (!km) {
    return undefined;
  }
  const info = km.getBlockInfo(key);
  const exp = info?.expiresAt;
  if (exp === undefined || exp === null) {
    return undefined;
  }
  return Math.max(0, Math.ceil((exp.getTime() - Date.now()) / 1000));
}

/**
 * @throws {Error} When both `penaltyBox` and `keyManager` are provided (mutually exclusive).
 * @throws {Error} When both `limits` array and `store` are provided (mutually exclusive).
 */
export function mergeRateLimiterOptions(options: Partial<RateLimitOptions>): RateLimitOptions {
  validateRateLimitHeaderOptions(options);
  if (options.penaltyBox !== undefined && options.keyManager !== undefined) {
    throw new Error(
      "Cannot use both 'penaltyBox' and 'keyManager' — use keyManager with penaltyBlockThreshold instead.",
    );
  }
  const limitsOpt = (options as WindowRateLimitOptions).limits;
  if (limitsOpt && limitsOpt.length > 0 && options.store !== undefined) {
    throw new Error('ratelimit-flex: `limits` and `store` are mutually exclusive');
  }
  const strategy = options.strategy ?? RateLimitStrategy.SLIDING_WINDOW;

  if (strategy === RateLimitStrategy.TOKEN_BUCKET) {
    const merged = {
      ...tokenBucketDefaults,
      ...baseDefaults,
      ...options,
      strategy: RateLimitStrategy.TOKEN_BUCKET as const,
    };
    const store =
      merged.store ??
      new MemoryStore({
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        tokensPerInterval: merged.tokensPerInterval,
        interval: merged.interval,
        bucketSize: merged.bucketSize,
      });
    return attachKeyManagerFromPenaltyBox({ ...merged, store } as RateLimitOptions);
  }

  const windowDefaults =
    strategy === RateLimitStrategy.FIXED_WINDOW ? fixedWindowDefaults : slidingWindowDefaults;

  const merged = {
    ...windowDefaults,
    ...baseDefaults,
    ...options,
    strategy,
  };

  const limits = (merged as WindowRateLimitOptions).limits;
  if (limits && limits.length > 0) {
    const sanitized = limits.map((entry: WindowLimitSpec) => ({
      windowMs: sanitizeWindowMs(entry.windowMs, 60_000),
      max: sanitizeRateLimitCap(entry.max, 100),
    }));
    const strategy =
      merged.strategy === RateLimitStrategy.FIXED_WINDOW
        ? RateLimitStrategy.FIXED_WINDOW
        : RateLimitStrategy.SLIDING_WINDOW;
    const store = limitsToComposedStore(
      strategy,
      sanitized.map((s) => ({ windowMs: s.windowMs, maxRequests: s.max })),
    );
    const minCap = Math.min(...sanitized.map((s) => s.max));
    const minWin = Math.min(...sanitized.map((s) => s.windowMs));
    return attachKeyManagerFromPenaltyBox({
      ...merged,
      store,
      limits,
      maxRequests: minCap,
      windowMs: minWin,
    } as RateLimitOptions);
  }

  const maxForStore = typeof merged.maxRequests === 'number' ? merged.maxRequests : 100;

  const store =
    merged.store ??
    new MemoryStore({
      strategy: merged.strategy,
      windowMs: merged.windowMs ?? 60_000,
      maxRequests: maxForStore,
    });

  return attachKeyManagerFromPenaltyBox({ ...merged, store } as RateLimitOptions);
}

export function toRateLimitInfo(
  opts: RateLimitOptions,
  result: RateLimitResult & { bindingSlotIndex?: number },
  req?: unknown,
): RateLimitInfo {
  return {
    limit: getLimit(opts, req, result.bindingSlotIndex),
    current: result.totalHits,
    remaining: result.remaining,
    resetTime: result.resetTime,
  };
}

export function jsonErrorBody(message: string | object): object {
  return { error: message };
}
