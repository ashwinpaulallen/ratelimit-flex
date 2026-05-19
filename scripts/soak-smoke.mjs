#!/usr/bin/env node
/**
 * Lightweight soak helper (manual — not part of default CI).
 * Exercise MemoryStore + FIFO queue for ~30s to catch obvious growth loops.
 *
 *   npm run soak-smoke
 */
import { createRateLimiterQueue } from '../dist/queue/createRateLimiterQueue.js';
import { RateLimitStrategy } from '../dist/types/index.js';

const deadline = Date.now() + 30_000;

const q = createRateLimiterQueue({
  strategy: RateLimitStrategy.FIXED_WINDOW,
  windowMs: 2000,
  maxRequests: 5,
});

let i = 0;
while (Date.now() < deadline) {
  const key = String(i % 4096);
  try {
    await q.removeTokens(key);
  } catch {
    /* ignore shutdown / timeouts during soak */
  }
  i++;
}

await q.shutdown();
console.log('[soak-smoke] iterations', i);
