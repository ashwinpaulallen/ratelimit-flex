# Operational failure modes

Quick reference for **what happens when something breaks or degrades**. For algorithm details see [PROJECT_GUIDE_FOR_FRESHERS.md](PROJECT_GUIDE_FOR_FRESHERS.md); for Redis failover depth see [REDIS_RESILIENCE.md](REDIS_RESILIENCE.md).

---

## Redis / quota store unavailable

Applies primarily to **`RedisStore`** (`onRedisError`, optional **`resilience`**). Similar patterns apply if another remote store consistently errors until you handle it in custom code.

| Configuration | Effect on quota (`increment`) | Allowlist / blocklist / penalty (engine) |
|---------------|------------------------------|----------------------------------------|
| **`onRedisError: 'fail-open'`** (Redis default without insurance) | Request is treated as **allowed** for quota; counter not updated reliably. Warning logged (`onWarn`). | **Still enforced** — engine runs before/with store depending on path; lists and penalty **do not depend on Redis** for quota. See README *Redis failure handling*. |
| **`onRedisError: 'fail-closed'`** | Request blocked with **503** + generic service-unavailable style body for quota failures. | **Still enforced.** |
| **`resilience`** with **`insuranceLimiter`** | Circuit opens → **`MemoryStore` per process** holds quota until Redis recovers; optional **replay** syncs counters back to Redis (**sliding-window replay timestamps** approximate real spread — see **`RedisStore` JSDoc**). Overrides binary fail-open/closed **for quota** while active. | Unchanged engine-side behavior. |

**`storeUnavailable: true`** on an increment result: middleware treats the request similarly to **`fail-open`** / **`fail-closed`** depending on your store’s policy (Redis maps this onto `onRedisError`).

---

## In-memory shield (`InMemoryShield` / `inMemoryBlock`)

| Path | Behavior | Store traffic |
|------|----------|----------------|
| **Shield hit** (key known blocked locally, entry not expired) | Short-circuit to **blocked** result (~in-memory latency). Uses cached outcome; **TTL/window semantics** depend on shield + backing store wiring. | **No** increment on backing store on that hit. |
| **Shield miss / expired entry** | Full path → **`increment`** on backing store (e.g. Redis). | Normal store round-trip. |
| **`KeyManager`** unblock / reward / delete | Should clear stale shield rows when wired; stale shield rows can briefly **over-block** until expiry if not cleared. | N/A |

---

## KeyManager sync lag (`RedisBlockStore` / **`syncIntervalMs`**)

| Situation | What operators see |
|-----------|---------------------|
| Block issued in **another process** | Local process may honor block only after **`syncIntervalMs`** (or **`await syncBlocks()`**). |
| Risk | Short window where a remote-blocked client can still hit a worker that hasn’t synced yet → tune **`syncIntervalMs`** vs Redis load / security needs. |

**User-supplied** `KeyManager` lifecycle is caller-owned — ensure **`destroy()`** on shutdown.

---

## Queued limiter (`expressQueuedRateLimiter` / `fastifyQueuedRateLimiter` / Hono **`queuedRateLimiter`**)

Driving **`RateLimiterQueue`** via **`store.increment`** means **middleware-level engine behaviors differ** from the ordinary limiter. See **[Engine vs queued parity](QUEUING.md#engine-middleware-vs-queued-middleware-parity)** in `QUEUING.md`.

Typical pitfalls:

| Topic | Behavior |
|-------|-----------|
| **Process exit** | Call **`queue.shutdown()`** — otherwise waiters see **503** / **`ShutdownError`** (v4+). See queuing README + `RateLimiterQueue` JSDoc. |
| **Multi-key FIFO** | One queue → **head-of-line blocking** across keys; use **`KeyedRateLimiterQueue`** for per-key queues. |

---

## ClusterStore / primary loss

Using **`ClusterStore`**: IPC to primary holds shared counters. Primary crash or mis-launch (e.g. **PM2 vs native `cluster`**) affects availability — README *When to use ClusterStore* describes PM2 incompatibility (**throws**).

---

## Where to drill deeper

| Topic | Document / code |
|--------|----------------|
| Deployment path selection | [DEPLOYMENT_PATHS.md](./DEPLOYMENT_PATHS.md) |
| Timeline diagrams | [OPERATIONAL_SEQUENCES.md](./OPERATIONAL_SEQUENCES.md) |
| Redis failover & insurance | [REDIS_RESILIENCE.md](./REDIS_RESILIENCE.md), `src/stores/redis-store.ts` (resilience hooks) |
| Queue semantics | [QUEUING.md](QUEUING.md), `src/queue/RateLimiterQueue.ts` |
| Header / `Retry-After` quirks (clock skew) | README *Standard headers* |
