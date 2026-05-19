/**
 * Lightweight in-process benchmarks for MemoryStore increments (no Redis).
 * Run from repo root: `npm run benchmark` (builds dist/ first).
 *
 * Tune with env: `BENCHMARK_OPS=500000 npm run benchmark`
 */
import { performance } from 'node:perf_hooks';
import { memoryUsage } from 'node:process';

import { MemoryStore, RateLimitStrategy } from '../dist/index.js';

const OPS = Number(process.env.BENCHMARK_OPS ?? '100000');
/** Round-robin keys — avoids exhausting sliding windows mid-bench */
const ROTATE_KEYS = 500;
const WINDOW_MS = 60_000;
const CEILING = 1_000_000;

async function benchmark(label, factory) {
  const store = factory();

  async function bump(i) {
    return store.increment(`bench-${(i % ROTATE_KEYS) + 1}`, { maxRequests: CEILING });
  }

  for (let w = 0; w < 3000; w++) await bump(w);

  if (typeof globalThis.gc === 'function') globalThis.gc({ global: true });

  const t0 = performance.now();
  for (let i = 0; i < OPS; i++) {
    await bump(i);
  }
  const elapsed = performance.now() - t0;

  await store.shutdown().catch(() => {});

  const rps = (OPS / elapsed) * 1000;
  console.log(`${label}: ${OPS.toLocaleString()} increments in ${elapsed.toFixed(1)} ms → ~${Math.round(rps).toLocaleString()} ops/s`);

  try {
    const mu = memoryUsage();
    if (typeof mu.heapUsed === 'number') {
      console.log(`  heapUsed after: ~${Math.round(mu.heapUsed / (1024 * 1024))} MiB`);
    }
  } catch {
    /* optional */
  }
}

console.log(
  `ratelimit-flex MemoryStore benchmarks — OPS=${OPS}, rotate=${ROTATE_KEYS} keys (${process.arch} ${process.version})\n`,
);

await benchmark('MemoryStore SLIDING_WINDOW', () =>
  new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: WINDOW_MS,
    maxRequests: CEILING,
  }),
);

await benchmark('MemoryStore FIXED_WINDOW', () =>
  new MemoryStore({
    strategy: RateLimitStrategy.FIXED_WINDOW,
    windowMs: WINDOW_MS,
    maxRequests: CEILING,
  }),
);

await benchmark('MemoryStore TOKEN_BUCKET', () =>
  new MemoryStore({
    strategy: RateLimitStrategy.TOKEN_BUCKET,
    interval: WINDOW_MS,
    tokensPerInterval: CEILING,
    bucketSize: CEILING,
  }),
);
