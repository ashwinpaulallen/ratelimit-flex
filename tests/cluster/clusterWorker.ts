/**
 * Entry script for Node.js cluster workers spawned by `cluster.integration.test.ts`.
 * Must be plain TS executed via `tsx` or precompiled; Vitest does not load this file as a test.
 */
import { ClusterStore } from '../../src/stores/ClusterStore.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const store = new ClusterStore({
  keyPrefix: 'test-limiter',
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 10,
  timeoutMs: 3000,
});

async function run(): Promise<void> {
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(await store.increment('user-1'));
  }
  const serializable = results.map((r) => ({
    totalHits: r.totalHits,
    remaining: r.remaining,
    isBlocked: r.isBlocked,
  }));
  process.send!({ type: 'test_results', results: serializable });
  // Intentionally no store.shutdown(): shutdown removes the keyPrefix on the primary and would
  // reset the shared MemoryStore before another worker runs in cluster.integration.test.ts.
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.send!({ type: 'test_error', error: message });
  process.exitCode = 1;
});
