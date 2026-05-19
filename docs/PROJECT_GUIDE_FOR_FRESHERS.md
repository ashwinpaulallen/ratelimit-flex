# ratelimit-flex — Project guide for beginners

This document explains **ratelimit-flex** (version 4.x) for readers who are new to rate limiting or to this codebase. It describes **what** the library does, **why** each piece exists, **how** the main algorithms work, and **when** to choose each option.

---

## 1. What problem does this solve?

**Rate limiting** means: *for each client (or API key, IP, user id, etc.), allow only a certain amount of traffic in a given time*. Without it, abusive users, buggy clients, or attackers can overload your servers, databases, or upstream APIs.

**ratelimit-flex** is a **TypeScript-first** library for **Node.js** that:

- Enforces limits using several **algorithms** (sliding window, fixed window, token bucket).
- Persists counters in **pluggable stores** (memory, Redis, PostgreSQL, MongoDB, DynamoDB, or composed combinations).
- Integrates with **Express**, **Fastify**, **NestJS**, and **Hono** through dedicated entry points.
- Adds **operational** features: metrics, Redis failover, in-memory “shield” for hot blocked keys, request **queues**, programmatic **key management**, and **composition** of multiple limit layers.

Think of it as: **policy** (how much is allowed) + **storage** (where counts live) + **HTTP glue** (middleware that runs before your route handlers).

---

## 2. Mental model: one request’s journey

For a typical HTTP request:

1. **Key** — The middleware builds a string key (often IP or API key) via `keyGenerator`. Every distinct key is tracked separately.
2. **Engine** (`RateLimitEngine`) — Applies **allowlist** / **blocklist**, **penalty box** or **KeyManager** blocks, optional **draft** mode, then asks the **store** to record usage.
3. **Store** — Runs the chosen **algorithm** (e.g. add a timestamp in a sliding window). Returns `totalHits`, `remaining`, `resetTime`, `isBlocked`.
4. **Response** — If allowed, the handler runs and optional **standard headers** (`RateLimit-*`, legacy `X-RateLimit-*`) may be attached. If blocked, the middleware responds with **429** (or your configured status) and may set **Retry-After**.
5. **After response** — Optional **skipFailedRequests** / **skipSuccessfulRequests** can **decrement** the store to “refund” quota when the handler returns certain status codes.

Non-HTTP code can use **`RateLimitEngine`** or **`createRateLimiterQueue`** directly (e.g. throttling outbound calls to a third-party API).

For **operators** debugging surprising behavior (**Redis outages**, **`InMemoryShield`**, **queued middleware** vs **`RateLimitEngine`**, **KeyManager** sync delays), keep **[FAILURE_MODES.md](./FAILURE_MODES.md)** open as a short checklist beside this journey.

---

## 3. The three core algorithms

All three answer: *“Should this request count toward the limit, and are we over the limit?”* They differ in **fairness**, **memory**, **burst behavior**, and **implementation complexity**.

### 3.1 Sliding window (`RateLimitStrategy.SLIDING_WINDOW`)

**Idea:** For each key, keep track of **events** (request times or weighted units) in the **last `windowMs` milliseconds**. If the count of those events exceeds `maxRequests`, block.

**Why use it**

- **Smooth behavior at window boundaries.** Unlike a naive fixed slice, you do not get a “double allowance” just because a burst straddles two clock windows.
- **Intuitive** for “100 requests per minute” style policies.

**How it works (conceptually)**

- **Memory / Redis:** Often implemented with a list of timestamps (or a sorted set in Redis). Old entries outside the window are removed; new ones are added; count is compared to the cap.
- **Cost:** For sliding window, a **cost** greater than 1 adds multiple “units” (e.g. an expensive endpoint counts as 10 requests).

**When to use**

- **Default choice** for HTTP APIs when you want predictable, smooth limiting.
- When boundary spikes from fixed windows would be unfair or abusable.

**Trade-offs**

- **More state** than fixed window (you store multiple timestamps per key, or equivalent in Redis Lua / DB).
- **DynamoDB:** The library uses a **weighted approximation** for sliding window (see [docs/stores/dynamo.md](stores/dynamo.md)); for **exact** sliding windows on AWS, prefer **Redis**, **PostgreSQL**, or **Mongo** stores from this package.

---

### 3.2 Fixed window (`RateLimitStrategy.FIXED_WINDOW`)

**Idea:** Time is divided into **fixed slices** (e.g. each minute). Each key has **one counter per slice**. When the slice changes, the counter resets.

**Why use it**

- **Simplest** mental model and **lowest memory** (one counter per key per active slice).
- Very fast to implement with `INCR` + TTL in Redis.

**How it works**

- At the start of a window, counter is 0; each request increments. Over `maxRequests` → block until the next slice.

**When to use**

- Prototyping, brute-force protection where a small amount of **burst at the boundary** is acceptable.
- Very high traffic where memory or Redis ops must be minimized.

**Trade-offs — important for freshers**

- **Boundary effect:** A client can send up to `maxRequests` at the end of one window and again at the start of the next — roughly **2×** the average rate in a short span. If that matters, use **sliding window** or **token bucket** with tuned burst.

---

### 3.3 Token bucket (`RateLimitStrategy.TOKEN_BUCKET`)

**Idea:** Each key has a **bucket** holding up to **`bucketSize`** tokens. Tokens **refill** at a steady rate: **`tokensPerInterval`** every **`interval`** ms. Each request **consumes** tokens (default cost 1). If not enough tokens remain, block.

**Why use it**

- **Allows bursts** up to `bucketSize` while maintaining a **long-term average** rate.
- Good for **spiky** traffic: mobile apps, retries, webhooks, or APIs where occasional bursts are normal.

**How it works**

- Between requests, “refill” is computed from elapsed time since `lastRefill`, capped at `bucketSize`.
- Each allowed request subtracts `cost` tokens.

**When to use**

- You want **average** throughput limits but **permit bursts** (e.g. “~30/min but up to 60 in a burst”).
- **API gateway** style presets often use token bucket semantics.

**Trade-offs**

- Burst size must be chosen carefully: too large → abusive spikes; too small → feels like a fixed window.

---

## 4. Stores: where state lives

The **`RateLimitStore`** interface is the contract: `increment`, `decrement`, `reset`, `shutdown`, plus optional helpers (`get`, `getActiveKeys`, etc.). **Algorithms** are implemented **inside** each store for the chosen strategy.

| Store | Sharing | Sliding / fixed / token | Notes |
|--------|---------|-------------------------|--------|
| **MemoryStore** | Single process only | Exact | Default LRU cap on distinct keys (default **100,000** in v4); protects memory. |
| **RedisStore** | Multi-instance | Exact (Lua scripts) | Atomic **EVAL** scripts; use for production clusters. |
| **ClusterStore** | Node `cluster` workers on one machine | Exact | IPC to primary; not for PM2 multi-process — use Redis instead. |
| **PgStore** | Shared PostgreSQL | Exact | Good when you already run Postgres; see [docs/stores/postgres.md](stores/postgres.md). |
| **MongoStore** | Shared MongoDB | Exact | Aggregation pipelines; TTL indexes for cleanup. |
| **DynamoStore** | AWS DynamoDB | Fixed & token **exact**; sliding **approximate** | Serverless-friendly; sliding uses weighted sub-windows. |

**When to choose which (short guide)**

- **One Node process, dev/test:** `MemoryStore`.
- **Many replicas / Kubernetes / serverless across machines:** `RedisStore` or DB-backed store with shared connection.
- **Node cluster module, one server, no Redis:** `ClusterStore` + `ClusterStorePrimary`.
- **AWS, no Redis:** `DynamoStore` with eyes open on sliding window approximation.

---

## 5. Framework integration (features)

### 5.1 Express (`ratelimit-flex`)

- **`expressRateLimiter(options)`** — Main middleware; default export is the same.
- **`expressQueuedRateLimiter`** — Waits in a queue instead of immediate 429 (see §7).

### 5.2 Fastify (`ratelimit-flex/fastify`)

- Separate package entry so installs without Fastify stay smaller.
- **`fastifyRateLimiter`**, **`fastifyQueuedRateLimiter`**.

### 5.3 NestJS (`ratelimit-flex/nestjs`)

- **`RateLimitModule.forRoot` / `forRootAsync`** — Global or scoped guard.
- **`@RateLimit()`**, **`@SkipRateLimit()`**, **`RateLimitGuard`**.
- **`RATE_LIMIT_KEY_MANAGER`** injection for `KeyManager`.
- One **strategy per module**; different algorithms per route typically mean **multiple modules** with different configs.

### 5.4 Hono (`ratelimit-flex/hono`)

- **`rateLimiter`**, **`queuedRateLimiter`**, **`webSocketLimiter`**.
- Documented parity with Express options; Cloudflare Workers may pass **`waitUntil`** for async decrement work after the response.

---

## 6. Major features (beyond basic limit + 429)

### 6.1 Weighted / cost-based limiting

- **`incrementCost`** (number or function of request): expensive operations consume more quota (e.g. upload = 10 units).
- Store **`increment(key, { cost })`** must match **`decrement(key, { cost })`** when rolling back.

**When to use:** Same route mix of cheap and expensive work; GraphQL complexity; large payloads.

---

### 6.2 Multi-window limits (`limits` or `compose.windows`)

- Several windows at once, e.g. **10/sec AND 100/min**.
- Request is blocked if **any** window is exceeded (logical **AND** of constraints).

**When to use:** Protect against both short spikes and sustained abuse.

---

### 6.3 Limiter composition (`compose`)

Combines multiple stores into one **`ComposedStore`**:

| Mode | Behavior | Typical use |
|------|----------|-------------|
| **`all`** | Block if **any** layer blocks; roll back others | Multi-window |
| **`overflow`** | Try primary, then burst layer | Steady + burst pool |
| **`firstAvailable`** | First layer that allows wins | Redis → memory failover |
| **`race`** | Parallel increments, fastest wins | Multi-region latency experiments |

See [docs/COMPOSITION.md](COMPOSITION.md).

---

### 6.4 In-memory block shield (`InMemoryShield` / `inMemoryBlock`)

**Problem:** Under attack, every request might still **call Redis** even when the key is already blocked — your app pays the latency and load.

**Solution:** After a key is known to be over limit, cache that **blocked state in process memory** for a duration so repeat requests **short-circuit** without hitting Redis.

**When to use:** Remote store + hot abusive keys; production Redis under DoS-style traffic.

**Caveat:** Per-process cache — not a substitute for shared limits across instances; it **reduces** load after the first full check.

---

### 6.5 Request queuing (`RateLimiterQueue`, `expressQueuedRateLimiter`, …)

**Behavior:** Instead of returning 429 immediately, the request **waits** in a FIFO queue until quota is available or **maxQueueTimeMs** / **maxQueueSize** is hit.

**When to use:** **Outbound** API throttling (call GitHub slowly), or inbound when brief **backpressure** is better than hard rejections.

**Head-of-line blocking:** One shared FIFO queue for **many keys** means key A’s waiter can delay key B — use **per-key queues** or **`KeyedRateLimiterQueue`** when fairness per key matters.

**Shutdown:** **`queue.shutdown()`** rejects waiters with **503** / `ShutdownError` (v4 behavior). See [docs/QUEUING.md](QUEUING.md).

---

### 6.6 KeyManager and admin API

**KeyManager** provides:

- **block / unblock** with reasons and expiry.
- **penalty / reward** points and **escalation** strategies (exponential, fibonacci, etc.).
- **Events** (`blocked`, `unblocked`, …) and an **audit log**.
- Optional **RedisBlockStore** so blocks can sync across processes.

**Admin HTTP API** — **`createAdminRouter`** (Express) / **`fastifyAdminPlugin`**: **v4 requires explicit `auth`** (bearer, basic, middleware, or unsafe dev-only). Never expose without authentication in production.

**Conflict:** You cannot set both **`penaltyBox`** (engine built-in) and a custom **`keyManager`** in the same options — the merger throws; pick one policy.

---

### 6.7 Penalty box (engine-level, optional)

- Counts **real** rate-limit violations in a sliding **`violationWindowMs`**.
- After **`violationsThreshold`**, applies **`penaltyDurationMs`** ban (in-memory in that process — not shared across instances unless you use KeyManager patterns).

**When to use:** Simple “three strikes” without pulling in full KeyManager.

---

### 6.8 Redis resilience (insurance + circuit breaker)

When Redis fails:

- **`onRedisError: 'fail-open'`** — allow traffic (no quota enforcement from Redis).
- **`'fail-closed'`** — block or 503-style behavior.

**Insurance limiter:** A dedicated **`MemoryStore`** used when the **circuit breaker** opens so each process still has **some** per-process limit. On recovery, counters may **sync** back to Redis (`syncOnRecovery`).

**When to use:** Production Redis paths where total outage should not mean unlimited traffic **or** total outage of the app.

---

### 6.9 Metrics and observability

- **`metrics: true`** or detailed **`MetricsConfig`** on Express/Fastify.
- **Counters**, **histograms** (middleware duration, store duration), **hot keys**, optional **Prometheus** and **OpenTelemetry** adapters.
- Collection is designed to be **cheap** on the request path; aggregation runs on a timer.

See [docs/METRICS.md](METRICS.md).

---

### 6.10 Standard headers

- Supports **legacy** `X-RateLimit-*` and IETF **draft-6 / draft-7 / draft-8** `RateLimit` / `RateLimit-Policy` style headers.
- Helps clients implement backoff consistently with **`Retry-After`** on 429.

---

### 6.11 Draft mode (`draft: true`)

- **Observes** what **would** have been blocked but does **not** block; useful for shadow testing new limits.

---

### 6.12 Compatibility and migration

- **`fromExpressRateLimitOptions`** maps from **express-rate-limit** style options.
- See [docs/MIGRATION.md](MIGRATION.md) for version upgrades.

---

## 7. Presets (opinionated defaults)

Presets return **`Partial<RateLimitOptions>`** — quick starts:

| Preset | Typical scenario |
|--------|------------------|
| `singleInstancePreset` | Dev, single process, in-memory |
| `multiInstancePreset` | Redis, multiple nodes |
| `resilientRedisPreset` | Redis + insurance + circuit breaker |
| `clusterPreset` / `queuedClusterPreset` | Node `cluster`, no Redis |
| `apiGatewayPreset` | Token bucket, API-key style |
| `authEndpointPreset` | Brute-force protection, fixed window, fail-closed |
| `publicApiPreset` | Simple public API defaults |
| `postgresPreset` / `mongoPreset` / `dynamoPreset` | DB/AWS stores |

---

## 8. Security and operations (must-know for freshers)

1. **Key cardinality** — A bad `keyGenerator` (e.g. full URL with random query params) creates millions of keys → memory/Redis blowup. Use **stable, low-cardinality** identifiers; hash if needed.
2. **Reverse proxies** — Configure **trust proxy** (Express) or **trustProxy** (Fastify) so `req.ip` is the real client when you key by IP.
3. **Redis namespace** — Use **`keyPrefix`** per app/tenant so environments do not collide.
4. **Admin routes** — Always **authenticate** `createAdminRouter` / Fastify admin plugin.
5. **Lua in Redis** — Scripts are **static**; user input only goes through **`KEYS`/`ARGV`**, not string-built Lua.

---

## 9. Package layout (where to read code)

| Area | Main locations |
|------|----------------|
| Engine | `src/strategies/rate-limit-engine.ts` |
| Stores | `src/stores/*.ts`, `src/stores/postgres/`, `src/stores/mongo/`, `src/stores/dynamo/` |
| Middleware | `src/middleware/express.ts`, `fastify.ts`, queued variants |
| Composition | `src/composition/` |
| Queue | `src/queue/` |
| Shield | `src/shield/` |
| Key manager | `src/key-manager/` |
| Metrics | `src/metrics/` |
| Cluster | `src/cluster/`, `src/stores/ClusterStore.ts` |
| Resilience | `src/resilience/CircuitBreaker.ts` |

Run **`npm run docs:api`** after clone to generate full TypeDoc HTML under `docs/api/`.

---

## 10. Glossary

| Term | Meaning |
|------|--------|
| **Key** | String identity for quota (IP, user id, API key hash, …). |
| **Quota / remaining** | How much allowance is left before block. |
| **Reset time** | When the window or bucket state next “turns over” meaningfully (for headers). |
| **Store** | Persistence layer implementing the algorithm. |
| **Engine** | Allow/block/draft + call store + interpret result. |
| **Composition** | Combining multiple stores as one logical limiter. |
| **Shield** | In-memory cache of “already blocked” to skip remote store calls. |
| **Insurance** | Fallback MemoryStore when Redis is down (with circuit breaker). |

---

## 11. Summary table: algorithm → when

| Goal | Prefer |
|------|--------|
| Fair, smooth “N per minute” | **Sliding window** |
| Minimum memory / simplest | **Fixed window** (accept boundary bursts) |
| Allow bursts, cap long-term average | **Token bucket** |
| Multiple time scales at once | **Multi-window** or **`compose.all`** |
| Survive Redis outage with *some* limit | **resilience** / **`resilientRedisPreset`** |
| Reduce Redis load on repeated blocks | **InMemoryShield** / **`inMemoryBlock`** |

---

*This guide reflects the **ratelimit-flex** codebase and published docs. For exact option names and defaults, rely on TypeScript types and the generated API docs.*
