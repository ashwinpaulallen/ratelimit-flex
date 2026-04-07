import type { RateLimitOptions, WindowRateLimitOptions } from '../types/index.js';
import { matchingDecrementOptions, resolveIncrementOpts } from '../strategies/rate-limit-engine.js';

/**
 * Best-effort decrement after a successful consume when skip-response rules apply
 * (Express / Fastify / Hono). Handles grouped windows vs single store.
 *
 * @internal
 */
export function decrementStoresAfterConsume(resolved: RateLimitOptions, key: string, req: unknown): void {
  void decrementStoresAfterConsumeAsync(resolved, key, req);
}

/**
 * Awaitable rollback for skip-response rules (e.g. {@link waitUntil} on Cloudflare Workers).
 *
 * @internal
 */
export async function decrementStoresAfterConsumeAsync(
  resolved: RateLimitOptions,
  key: string,
  req: unknown,
): Promise<void> {
  const incOpts = resolveIncrementOpts(resolved, req);
  const decOpts = matchingDecrementOptions(incOpts);
  const w = resolved as WindowRateLimitOptions;
  if (w.groupedWindowStores && w.groupedWindowStores.length > 0) {
    await Promise.all(
      w.groupedWindowStores.map((g) =>
        g.store.decrement(key, decOpts).catch(() => {
          /* ignore */
        }),
      ),
    );
    return;
  }
  await resolved.store.decrement(key, decOpts).catch(() => {
    /* ignore */
  });
}
