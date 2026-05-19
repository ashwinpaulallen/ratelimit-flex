# Benchmarking

## Shipped micro-benchmark (MemoryStore)

From a git checkout:

```bash
npm install
npm run benchmark
```

This runs **`scripts/benchmark.mjs`**: **`MemoryStore.increment`** throughput for sliding, fixed-window, and token-bucket paths (round-robin keys; optional **`BENCHMARK_OPS`** env).

**Interpreting results:** throughput depends on CPU, GC, and **`BENCHMARK_OPS`**. Figures in the README *Performance benchmarks* tables were historically produced with broader harnesses; treat README numbers as **order-of-magnitude** unless you reproduce with pinned hardware.

**Manual soak:** **`npm run soak-smoke`** (builds then runs **`scripts/soak-smoke.mjs`** for ~30s of queue traffic) is meant for spotting runaway allocations when changing queue/store internals; it does not emit CI-grade numbers.

## Redis and network backends

Micro-benchmarks for **`RedisStore`**, **`PgStore`**, etc. are intentionally **not** scripted in-repo (they depend on Docker networking, pooling, latency). To compare:

1. Run **`npm run benchmark`** locally for in-process sanity.
2. Use your own **`autocannon` / `k6`** against a trivial HTTP route using **`RedisStore`**, pinned Node + Redis version, and documented key cardinality (single-key ≈ pessimistic contention).
3. Keep **monitoring overhead** comparable (`metrics: false` vs `true`) when isolating regressions.

## CI

The **CI** workflow does **not** fail on benchmark thresholds (too noisy cross-runners).
