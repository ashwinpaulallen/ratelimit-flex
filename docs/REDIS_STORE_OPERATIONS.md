# Redis store operations (`RedisStore`)

Practical deployment notes complementary to README *When to use RedisStore* and [REDIS_RESILIENCE.md](REDIS_RESILIENCE.md).

## Connections and pooling

| Practice | Reason |
|---------|--------|
| **Reuse one client per Node process** (or per warm isolate) | `RedisStore` issues **`EVAL`** per check; ephemeral clients drop **EVALSHA / script cache warmth** on Redis and inflate latency ([examples/redis/README.md](../examples/redis/README.md)). |
| **Pool size mirrors concurrency**, not replicas × routes | Burst traffic should share a bounded pool tuned to **`maxSockets`** / backlog your driver exposes. |

## Sentinel / OSS cluster / replicas

ratelimit-flex tests against a **logical Redis endpoint** exposing standard commands + Lua; **topology is your broker’s responsibility**.

- **`ioredis`**: use **Redis Sentinel**, **OSS Cluster**, or managed DNS targets as supported by `ioredis` options.
- **`EVAL`** must land on node holding the keyed slot (cluster-hash-tag your **`keyPrefix`** if you intentionally co-locate correlated keys).

**Reads from replicas**: rate limiting executes **Lua writes** (`EVAL`); replicas are irrelevant for correctness—send traffic to masters.

## Valkey / API-compatible clones

Engines that advertise **RESP + Lua eval** parity with OSS Redis paths **generally work** (`RedisStore` only uses primitives already exercised by Redis **6.2-class** setups). Smoke-test increments + resilience replay in **staging**.

## Troubleshooting throughput

High CPU on Redis Lua → tighten window keys (shared vs per-route), shorten sliding retention (window size × rate), **lower key cardinality**.
