import type { RateLimitOptions, WindowRateLimitOptions } from '../types/index.js';
import { matchingDecrementOptions, resolveIncrementOpts } from '../strategies/rate-limit-engine.js';

/**
 * Best-effort decrement after a successful consume when skip-response rules apply
 * (Express / Fastify / Hono). Handles grouped windows vs single store.
 *
 * @internal
 */
export function decrementStoresAfterConsume(resolved: RateLimitOptions, key: string, req: unknown): void {
  const incOpts = resolveIncrementOpts(resolved, req);
  const decOpts = matchingDecrementOptions(incOpts);
  const w = resolved as WindowRateLimitOptions;
  if (w.groupedWindowStores && w.groupedWindowStores.length > 0) {
    for (const g of w.groupedWindowStores) {
      void g.store.decrement(key, decOpts).catch(() => {
        /* ignore */
      });
    }
    return;
  }
  void resolved.store.decrement(key, decOpts).catch(() => {
    /* ignore */
  });
}
