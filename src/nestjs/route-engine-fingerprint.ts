import type {
  RateLimitOptions,
  TokenBucketRateLimitOptions,
  WindowRateLimitOptions,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function objectId(o: object): number {
  let id = objectIds.get(o);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(o, id);
  }
  return id;
}

/**
 * Stable string for {@link RateLimitEngine} config equality (per-handler cache invalidation in
 * {@link RateLimitGuard}). Includes store identity and the option fields that affect engine behavior.
 *
 * @internal
 */
export function fingerprintRouteEngineOptions(opts: RateLimitOptions): string {
  const inc = opts.incrementCost;
  const incPart =
    typeof inc === 'number' ? inc : typeof inc === 'function' ? 'fn' : 'absent';

  const parts: Record<string, unknown> = {
    strategy: opts.strategy,
    store: objectId(opts.store as object),
    ic: incPart,
  };

  if (opts.keyManager !== undefined) {
    parts.km = objectId(opts.keyManager as object);
  }

  if (opts.strategy === RateLimitStrategy.TOKEN_BUCKET) {
    const t = opts as TokenBucketRateLimitOptions;
    parts.tpi = t.tokensPerInterval;
    parts.int = t.interval;
    parts.bs = t.bucketSize;
  } else {
    const w = opts as WindowRateLimitOptions;
    parts.wm = w.windowMs;
    const mr = w.maxRequests;
    parts.mr = typeof mr === 'number' ? mr : 'fn';
    if (w.limits !== undefined && w.limits.length > 0) {
      parts.limits = w.limits.map((l) => [l.windowMs, l.max]);
    }
    if (w.groupedWindowStores !== undefined && w.groupedWindowStores.length > 0) {
      parts.gw = w.groupedWindowStores.map((g) => [
        g.windowMs,
        g.maxRequests,
        objectId(g.store as object),
      ]);
    }
  }

  return JSON.stringify(parts);
}
