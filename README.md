# ratelimit-flex

Flexible, TypeScript-first rate limiting for Node.js with Express and Fastify.

[![npm version](https://img.shields.io/npm/v/ratelimit-flex.svg)](https://www.npmjs.com/package/ratelimit-flex)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
![Tests](https://img.shields.io/badge/tests-vitest%20passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-First-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)

- **Three strategies:** sliding window, token bucket, fixed window
- **Frameworks:** Express and Fastify (separate entry for Fastify to keep bundles lean)
- **Stores:** `MemoryStore` (in-process), `RedisStore` (shared, Lua-backed), and `ClusterStore` (Node.js native cluster IPC)
- **Request queuing:** Queue over-limit requests instead of rejecting them immediately (`expressQueuedRateLimiter`, `fastifyQueuedRateLimiter`, `createRateLimiterQueue`)
- **TypeScript-first:** strict types, discriminated options where it matters
- **Redis resilience:** insurance limiter fallback, circuit breaker, counter sync on recovery; or **`fail-open`** / **`fail-closed`** when Redis is unavailable without insurance ([Redis failure handling](#redis-failure-handling), [Redis resilience](#redis-resilience))
- **In-memory block shielding:** `InMemoryShield` / `inMemoryBlock` — cache blocked keys in process memory so hot keys stop hitting Redis under attack ([In-memory block shielding](#in-memory-block-shielding))
- **Metrics & observability (Express & Fastify):** aggregated snapshots, Prometheus, OpenTelemetry — `metrics: true`
- **Weighted requests:** `incrementCost` (or `store.increment(..., { cost })`) so expensive endpoints consume more quota than cheap ones
- **Presets:** `singleInstancePreset`, `multiInstancePreset`, `resilientRedisPreset`, `clusterPreset`, `queuedClusterPreset`, `apiGatewayPreset`, `authEndpointPreset`, `publicApiPreset`
- **Limiter composition:** `compose.all()`, `compose.overflow()`, `compose.firstAvailable()`, `compose.race()`, `compose.windows()`, `compose.withBurst()`, nested `ComposedStore` — see [Limiter composition](#limiter-composition)
- **Programmatic key management:** `KeyManager` for blocks, penalties, rewards, events, audit log, and optional admin HTTP API — see [Programmatic key management](#programmatic-key-management)

## Installation

```bash
npm install ratelimit-flex
```

```bash
yarn add ratelimit-flex
```

```bash
pnpm add ratelimit-flex
```

**Peer dependencies (install only what you use):**

| Package | When you need it |
|---------|------------------|
| `express` (+ `@types/express` for TS) | Express middleware |
| `fastify`, `fastify-plugin` | Fastify plugin (`ratelimit-flex/fastify`) |
| `ioredis` | `RedisStore` with `url` (or use your own Redis client adapter) |
| `prom-client` | Optional: `metrics.prometheus.registry` integration |
| `@opentelemetry/api` | Optional: `metrics.openTelemetry.meter` integration |

All peers are optional at install time; the runtime you choose must be present when you import that integration.

**Node.js:** `>= 20` (see `package.json` `engines`).

## Quick Start

**Express (6 lines):**

```ts
import express from 'express';
import rateLimit from 'ratelimit-flex';

const app = express();
app.use(rateLimit({ maxRequests: 100, windowMs: 60_000 }));
app.get('/health', (_req, res) => res.json({ ok: true }));
```

**Fastify (6 lines):**

```ts
import Fastify from 'fastify';
import { fastifyRateLimiter } from 'ratelimit-flex/fastify';

const app = Fastify();
await app.register(fastifyRateLimiter, { maxRequests: 100, windowMs: 60_000 });
app.get('/health', async () => ({ ok: true }));
```

## In-memory block shielding

### Problem statement

Under DoS conditions, every blocked request still hits Redis — 100k req/sec from an attacker means 100k Redis calls/sec **from your own app**. `InMemoryShield` caches blocked keys in local memory so subsequent requests for the same key never touch the store. Result: 7x+ faster under attack, 99%+ fewer store calls.

### Quick start

```typescript
// Option 1: via middleware options (simplest)
app.use(expressRateLimiter({
  store: new RedisStore({ url: REDIS_URL, ... }),
  maxRequests: 100,
  windowMs: 60_000,
  inMemoryBlock: true, // shield kicks in at maxRequests
}));

// Option 2: explicit shield with custom config
import { shield, RedisStore } from 'ratelimit-flex';
const shielded = shield(new RedisStore({ ... }), {
  blockOnConsumed: 100,
  maxBlockedKeys: 10_000,
  onBlock: (key) => console.log(`Shielded: ${key}`),
});
app.use(expressRateLimiter({ store: shielded, maxRequests: 100, windowMs: 60_000 }));
```

### Metrics

```typescript
const metrics = limiter.shield?.getMetrics();
// {
//   blockedKeyCount: 42,        // keys currently blocked in memory
//   storeCallsSaved: 98721,     // total store calls avoided
//   totalKeysBlocked: 150,      // total keys blocked since startup
//   totalKeysExpired: 80,       // keys removed due to window expiry
//   totalKeysEvicted: 28,       // keys removed due to LRU eviction
//   hitRate: 0.993,             // cache hit rate
//   storeCalls: 684             // actual store calls made
// }
```

### How it works

Each request first checks an in-memory map for the key: if the key is still “shielded” (blocked and not yet expired), the limiter returns the cached blocked result in about **~0.01ms** — no Redis round-trip. If there is no entry, or it expired, the request takes the slow path: **`increment()` on the backing store** (typically **~2–5ms** for Redis, depending on network and load). When the store shows the key has consumed enough quota, the shield records that state locally and keeps serving blocked responses from RAM until the block window expires or you invalidate the entry (for example via `KeyManager`).

`InMemoryShield` implements **`RateLimitStore`**: wrap Redis, a composed store, or any custom implementation; use it with **`compose.*`** and multi-layer setups; expose shield metrics alongside Prometheus/OpenTelemetry; opt into **`onBlock`**, **`onExpire`**, and **`onShieldHit`** callbacks; and wire **`KeyManager`** so reward, unblock, and delete operations clear stale shield entries.

## Programmatic key management

ratelimit-flex exposes a `KeyManager` for programmatic control of rate limit keys. Block abusive clients, apply penalty/reward points, inspect state, and react to events — all with full TypeScript types, an audit trail, and optional Redis persistence.

### Basic usage

```typescript
import express from 'express';
import { KeyManager, MemoryStore, RateLimitStrategy, expressRateLimiter } from 'ratelimit-flex';

const app = express();
const store = new MemoryStore({ strategy: RateLimitStrategy.SLIDING_WINDOW, windowMs: 60_000, maxRequests: 100 });
const keyManager = new KeyManager({ store, maxRequests: 100, windowMs: 60_000 });

const limiter = expressRateLimiter({ store, keyManager });
app.use(limiter);

// Programmatic control — from an admin route, webhook handler, etc.
await keyManager.block('abusive-ip', 3600_000, { type: 'manual', message: 'Spam detected' });
await keyManager.penalty('suspicious-user', 5);
await keyManager.reward('verified-user', 10);
const state = await keyManager.get('any-key');
```

### Escalating penalties

```typescript
import { KeyManager, exponentialEscalation } from 'ratelimit-flex';

const keyManager = new KeyManager({
  store,
  maxRequests: 100,
  windowMs: 60_000,
  penaltyBlockThreshold: 3,
  penaltyEscalation: exponentialEscalation(60_000), // 1min, 2min, 4min, 8min...
});
```

### Event-driven alerting

```typescript
keyManager.on('blocked', ({ key, reason }) => {
  alerting.send(`Key ${key} blocked: ${reason.type}`);
});
```

### Admin endpoints

```typescript
import { createAdminRouter } from 'ratelimit-flex';

app.use('/admin/ratelimit', authMiddleware, createAdminRouter(keyManager));
// GET /admin/ratelimit/keys/:key
// POST /admin/ratelimit/keys/:key/block
// etc.
```

### What `KeyManager` provides

`KeyManager` gives you typed **block reasons** (`manual`, `penalty-escalation`, `abuse-pattern`, `custom`), an **event emitter** (`blocked`, `unblocked`, `penalized`, `rewarded`, and more), an **audit log** with filtering, **escalation strategies** for automatic penalty blocks, optional **admin REST endpoints** (`createAdminRouter`, `fastifyAdminPlugin`), and optional **Redis-backed block persistence** (`RedisBlockStore`) so block state can be shared across processes.

### Redis-backed block persistence

Share block state across processes using `RedisBlockStore`:

```typescript
import { KeyManager, RedisBlockStore, RedisStore, RateLimitStrategy } from 'ratelimit-flex';
import Redis from 'ioredis';

// Create a single Redis client instance
const redis = new Redis(process.env.REDIS_URL!);

// Share the client between RedisStore (for rate limit counters) and RedisBlockStore (for blocks)
const store = new RedisStore({
  client: redis,
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
});

const blockStore = new RedisBlockStore(redis, { keyPrefix: 'rlf:blocks:' });

const keyManager = new KeyManager({
  store,
  blockStore,
  maxRequests: 100,
  windowMs: 60_000,
  syncIntervalMs: 5000, // Pull remote blocks every 5 seconds
});

// Blocks are now persisted to Redis and visible across all processes
await keyManager.block('abusive-ip', 3600_000, { type: 'manual', message: 'Spam' });
```

**Cross-process consistency:** `KeyManager` syncs blocks from Redis every `syncIntervalMs` (default 5000ms). Call `await keyManager.syncBlocks()` manually for immediate consistency.

### Migrating from `penaltyBox`

The `penaltyBox` option is now powered by `KeyManager` internally. For full control, migrate to `KeyManager`:

**Before (penaltyBox):**

```typescript
app.use(expressRateLimiter({
  store,
  penaltyBox: {
    violationsThreshold: 3,
    penaltyDurationMs: 60_000,
  },
}));
```

**After (KeyManager):**

```typescript
const keyManager = new KeyManager({
  store,
  maxRequests: 100,
  windowMs: 60_000,
  penaltyBlockThreshold: 3,
  penaltyBlockDurationMs: 60_000,
});

app.use(expressRateLimiter({ store, keyManager }));

// Now you have programmatic access:
await keyManager.block('abusive-ip', 3600_000, { type: 'manual' });
keyManager.on('blocked', ({ key, reason }) => console.log(`Blocked: ${key}`));
```

**Benefits of migrating:**
- Typed block reasons (`manual`, `penalty-escalation`, `abuse-pattern`, `custom`)
- Event system for real-time alerting
- Audit log with filtering
- Escalation strategies (exponential, fibonacci, etc.)
- Admin HTTP endpoints
- Redis-backed block persistence

## Limiter composition

Combine multiple rate limiters with the `compose` builder. Every composition mode implements `RateLimitStore`, so composed stores plug directly into `expressRateLimiter` / `fastifyRateLimiter` via the `store` option.

### Composition modes

| Mode | Behavior | Use case | API |
|------|----------|----------|-----|
| **`all`** | Block if **any** layer blocks; rollback succeeded layers when one blocks | Multi-window limiting (10/sec AND 100/min AND 1000/hour) | `compose.all(...)` |
| **`overflow`** | Try primary first; if blocked, try burst pool (primary counts stay) | Steady rate + burst allowance (5/sec + 20 burst tokens) | `compose.overflow(primary, burst)` or `compose.withBurst({ ... })` |
| **`first-available`** | Try layers in order; first that allows wins (failed attempts rolled back) | Failover chain (Redis → fallback memory) | `compose.firstAvailable(...)` |
| **`race`** | Fire all layers in parallel; fastest response wins | Multi-region latency optimization | `compose.race(...)` |

### Examples

**Multi-window** (10/sec AND 100/min — both must allow):

```typescript
import { compose, expressRateLimiter, MemoryStore, RateLimitStrategy } from 'ratelimit-flex';

const store = compose.all(
  compose.layer('per-sec', new MemoryStore({ 
    strategy: RateLimitStrategy.SLIDING_WINDOW, 
    windowMs: 1_000, 
    maxRequests: 10 
  })),
  compose.layer('per-min', new MemoryStore({ 
    strategy: RateLimitStrategy.SLIDING_WINDOW, 
    windowMs: 60_000, 
    maxRequests: 100 
  })),
);

app.use(expressRateLimiter({ store }));
```

**Shorthand** — `compose.windows()` auto-creates `MemoryStore` instances:

```typescript
import { compose, expressRateLimiter } from 'ratelimit-flex';

const store = compose.windows(
  { windowMs: 1_000, maxRequests: 10 },
  { windowMs: 60_000, maxRequests: 100 },
);

app.use(expressRateLimiter({ store }));
```

**Burst allowance** (steady rate + burst pool):

```typescript
import { compose, expressRateLimiter } from 'ratelimit-flex';

const store = compose.withBurst({
  steady: { windowMs: 1_000, maxRequests: 5 },
  burst:  { windowMs: 60_000, maxRequests: 20 },
});

app.use(expressRateLimiter({ store }));
```

**Failover chain** (try Redis, fall back to memory):

```typescript
import { compose, expressRateLimiter, MemoryStore, RedisStore, RateLimitStrategy } from 'ratelimit-flex';

const primary = new RedisStore({ 
  url: process.env.REDIS_URL!, 
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
  onRedisError: 'fail-open',
});

const fallback = new MemoryStore({ 
  strategy: RateLimitStrategy.SLIDING_WINDOW, 
  windowMs: 60_000, 
  maxRequests: 100 
});

const store = compose.firstAvailable(
  compose.layer('redis', primary),
  compose.layer('memory', fallback),
);

app.use(expressRateLimiter({ store }));
```

**Nested composition** — `ComposedStore` can be a layer in another `ComposedStore`:

```typescript
import { compose, expressRateLimiter } from 'ratelimit-flex';

// Overflow (steady + burst) inside all (with hour cap)
const rate = compose.overflow(
  compose.layer('steady', steadyStore),
  compose.layer('burst', burstStore),
);

const store = compose.all(
  compose.layer('rate', rate),
  compose.layer('hourly-cap', hourlyCapStore),
);

app.use(expressRateLimiter({ store }));
```

### Per-layer observability

```typescript
import { compose, expressRateLimiter } from 'ratelimit-flex';

const store = compose.all(
  compose.layer('per-sec', perSecStore),
  compose.layer('per-min', perMinStore),
);

app.use(expressRateLimiter({
  store,
  onLayerBlock: (req, label, layerResult) => {
    console.log(`Layer '${label}' blocked:`, layerResult);
  },
}));

// Access per-layer results
app.use((req, res, next) => {
  if (req.rateLimitComposed?.layers) {
    console.log('Per-second:', req.rateLimitComposed.layers['per-sec']);
    console.log('Per-minute:', req.rateLimitComposed.layers['per-min']);
  }
  next();
});

// Human-readable summary
console.log(store.summarize('client-key'));
// "ALLOWED by 'per-sec' | per-sec: 9/10 remaining | per-min: 99/100 remaining"
```

### Redis composition presets

**Multi-window with Redis** (10/sec + 100/min + 1000/hour):

```typescript
import { expressRateLimiter, multiWindowPreset } from 'ratelimit-flex';

app.use(expressRateLimiter(
  multiWindowPreset(
    { url: process.env.REDIS_URL! },
    [
      { windowMs: 1_000, maxRequests: 10 },
      { windowMs: 60_000, maxRequests: 100 },
      { windowMs: 3_600_000, maxRequests: 1000 },
    ],
  ),
));
```

**Burst with Redis**:

```typescript
import { expressRateLimiter, burstablePreset } from 'ratelimit-flex';

app.use(expressRateLimiter(
  burstablePreset(
    { url: process.env.REDIS_URL! },
    {
      steady: { windowMs: 1_000, maxRequests: 5 },
      burst: { windowMs: 60_000, maxRequests: 20 },
    },
  ),
));
```

**Failover preset**:

```typescript
import { expressRateLimiter, failoverPreset } from 'ratelimit-flex';

app.use(expressRateLimiter(
  failoverPreset([
    { label: 'primary', store: primaryRedisStore },
    { label: 'fallback', store: fallbackMemoryStore },
  ]),
));
```

### Composition highlights

| Capability | In ratelimit-flex |
|------------|-------------------|
| Multi-window limits (every window must allow) | `compose.all()` — implements `RateLimitStore` for Express/Fastify middleware |
| Steady rate + burst pool | `compose.overflow()` or `compose.withBurst()` |
| Nested compositions | Any `ComposedStore` can be a layer inside another |
| Per-layer visibility | `onLayerBlock`, `req.rateLimitComposed`, `summarize()`, `extractLayerMetrics()` |

### Migration from `limits` array

The `limits` array is now powered by the composition system internally. **Existing code works unchanged:**

```typescript
// Still works (backward compatible)
app.use(expressRateLimiter({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  limits: [
    { windowMs: 1_000, max: 10 },
    { windowMs: 60_000, max: 100 },
  ],
}));

// Equivalent with compose (more control)
app.use(expressRateLimiter({
  store: compose.windows(
    { windowMs: 1_000, maxRequests: 10 },
    { windowMs: 60_000, maxRequests: 100 },
  ),
}));
```

## Request queuing

**Typical use case:** Outbound API throttling (one queue per external API, single key for all requests).

**Head-of-line blocking:** The queue is a single FIFO array. If you use multiple different keys with the same queue, a blocked request for key "A" will cause requests for key "B" to wait, even if "B" has capacity. For independent keys, create one queue per key instead (see examples below).

```typescript
// Outbound API rate limiting (non-HTTP)
import { createRateLimiterQueue } from 'ratelimit-flex';

const githubQueue = createRateLimiterQueue({
  maxRequests: 30,
  windowMs: 60_000,
  maxQueueSize: 200,
});

// In your code — waits instead of rejecting
await githubQueue.removeTokens('github-api');
const response = await fetch('https://api.github.com/repos/...');
```

```typescript
// HTTP middleware — queue instead of 429 (Express)
import { expressQueuedRateLimiter } from 'ratelimit-flex';

app.use('/slow-endpoint', expressQueuedRateLimiter({
  maxRequests: 5,
  windowMs: 10_000,
  maxQueueSize: 50,
  maxQueueTimeMs: 30_000,
}));
// Requests over 5/10s are held and released when quota opens up
```

```typescript
// HTTP middleware — queue instead of 429 (Fastify)
import { fastifyQueuedRateLimiter } from 'ratelimit-flex/fastify';

await app.register(fastifyQueuedRateLimiter, {
  maxRequests: 5,
  windowMs: 10_000,
  maxQueueSize: 50,
  maxQueueTimeMs: 30_000,
});
// Requests over 5/10s are held and released when quota opens up
// Fastify plugin automatically calls queue.shutdown() on server close
```

**Multiple independent keys:** Create one queue per key to avoid head-of-line blocking:

```typescript
// ❌ Bad: single queue with multiple keys causes head-of-line blocking
const sharedQueue = createRateLimiterQueue({ maxRequests: 10, windowMs: 1000 });
await sharedQueue.removeTokens('user:alice'); // Blocks...
await sharedQueue.removeTokens('user:bob');   // ...waits even if bob has capacity

// ✅ Good: separate queue per key
const queues = new Map<string, RateLimiterQueue>();
function getQueue(userId: string) {
  if (!queues.has(userId)) {
    queues.set(userId, createRateLimiterQueue({ maxRequests: 10, windowMs: 1000 }));
  }
  return queues.get(userId)!;
}
await getQueue('alice').removeTokens('user:alice'); // Independent
await getQueue('bob').removeTokens('user:bob');     // Independent
```

**Graceful shutdown:**

```typescript
// Express: manually call shutdown on SIGTERM
const limiter = expressQueuedRateLimiter({ maxRequests: 10, windowMs: 60_000 });
app.use(limiter);

process.on('SIGTERM', async () => {
  limiter.queue.shutdown(); // Rejects all pending requests and closes the store
  await server.close();
});
```

```typescript
// Fastify: automatic shutdown via onClose hook
await app.register(fastifyQueuedRateLimiter, {
  maxRequests: 10,
  windowMs: 60_000,
});
// Plugin automatically calls queue.shutdown() when server closes
```

**Store ownership:** The queue takes ownership of the backing store. Calling `queue.shutdown()` will close the store via `store.shutdown()`. If you share a store across multiple queues or components, use `queue.clear()` instead of `queue.shutdown()` to avoid closing the shared store prematurely.

## Choosing a strategy

| Strategy       | Best for                     | Accuracy | Memory | Burst handling   |
|----------------|------------------------------|----------|--------|------------------|
| Sliding window | General API rate limiting    | High     | Medium | Smooth           |
| Token bucket   | APIs that allow bursts       | High     | Low    | Allows bursts    |
| Fixed window   | Simple counting, low memory  | Moderate | Low    | Edge spikes      |

**Sliding window** — Counts requests in a moving time window. Best default when you care about fairness and boundary behavior (no big “reset line” artifacts).

```ts
import { expressRateLimiter, RateLimitStrategy } from 'ratelimit-flex';

app.use(
  expressRateLimiter({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 100,
  }),
);
```

**Token bucket** — Refills tokens on a schedule; clients can burst up to `bucketSize`. Good for spiky traffic (mobile, retries, webhooks).

```ts
import { expressRateLimiter, RateLimitStrategy } from 'ratelimit-flex';

app.use(
  expressRateLimiter({
    strategy: RateLimitStrategy.TOKEN_BUCKET,
    tokensPerInterval: 20,
    interval: 60_000,
    bucketSize: 60,
  }),
);
```

**Fixed window** — One counter per fixed time slice. Simplest and lightest; acceptable when occasional boundary spikes are OK (internal tools, coarse limits).

```ts
import { expressRateLimiter, RateLimitStrategy } from 'ratelimit-flex';

app.use(
  expressRateLimiter({
    strategy: RateLimitStrategy.FIXED_WINDOW,
    windowMs: 60_000,
    maxRequests: 100,
  }),
);
```

## Weighted / cost-based rate limiting

By default each request consumes **one** quota unit. For endpoints that should count more (file uploads, heavy database work, high GraphQL complexity), use a **cost** greater than `1`.

**Middleware / engine** — set **`incrementCost`** on the rate limiter options (number or function of the request):

```ts
import { expressRateLimiter } from 'ratelimit-flex';

app.use(
  expressRateLimiter({
    maxRequests: 100,
    windowMs: 60_000,
    incrementCost: (req) =>
      String((req as import('express').Request).path ?? '').startsWith('/upload') ? 10 : 1,
  }),
);
```

**Custom pipelines** — call the store directly with **`increment`** / **`decrement`** options:

```ts
await store.increment(key, { cost: 10 });
// … later, undo the same weight (e.g. custom skip logic):
await store.decrement(key, { cost: 10 });
```

Dynamic caps plus cost still work together: **`increment`** accepts **`{ maxRequests?, cost? }`** on window strategies.

Helpers **`resolveIncrementOpts(options, req)`** and **`matchingDecrementOptions(incOpts)`** are exported if you build your own middleware and need the same increment/decrement pairing as the built-in engine.

**Redis implementation note:** for sliding windows with **`cost > 1`**, each ZSET member is a distinct random value so Redis never silently merges two hits into one.

## Deployment guide

### When to use MemoryStore

Use **MemoryStore** when:

- One Node process serves all traffic (no horizontal scale)
- Local development and prototyping
- Automated tests
- Small deployments with a single instance

Counters live **only in that process**. No Redis required.

```ts
import { expressRateLimiter, MemoryStore, RateLimitStrategy } from 'ratelimit-flex';

const store = new MemoryStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
});

app.use(expressRateLimiter({ store, windowMs: 60_000, maxRequests: 100 }));
```

If you omit `store`, the middleware creates a `MemoryStore` from `windowMs` / `maxRequests` (or token-bucket fields).

### When to use ClusterStore

Use **ClusterStore** when:

- Node.js native **`cluster`** module (not PM2)
- No Redis available or desired
- Single server with multiple CPU cores

```ts
// primary.ts (ESM — top-level await)
import cluster from 'node:cluster';
import { ClusterStorePrimary } from 'ratelimit-flex';

if (cluster.isPrimary) {
  ClusterStorePrimary.init();
  for (let i = 0; i < 4; i++) cluster.fork();
} else {
  await import('./app.js');
}
```

```ts
// app.ts (worker)
import express from 'express';
import { expressRateLimiter, clusterPreset } from 'ratelimit-flex';

const app = express();
app.use(expressRateLimiter(clusterPreset({ maxRequests: 100, windowMs: 60_000 })));
```

### When to use RedisStore

Use **RedisStore** when:

- Multiple Node processes (e.g. PM2 cluster)
- Multiple servers behind a load balancer
- Kubernetes, Docker Swarm, or similar
- Microservices where the same client can hit **different** instances
- You need one global limit across replicas

```ts
import { expressRateLimiter, RedisStore, RateLimitStrategy } from 'ratelimit-flex';

const store = new RedisStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
  url: process.env.REDIS_URL!,
});

app.use(expressRateLimiter({ store, strategy: RateLimitStrategy.SLIDING_WINDOW }));
```

Prefer passing a **shared Redis URL or client** from every instance. Use a **distinct key prefix** (`keyPrefix`) per app or per limiter if several services share one Redis.

**Multi-window:** The convenience **`limits: [{ windowMs, max }, …]`** option (see [Multi-window limits (`limits`)](#multi-window-limits-limits)) creates one **`MemoryStore` per window**. It does **not** switch those slots to Redis automatically. For the same multi-window policy across horizontally scaled processes, build **`groupedWindowStores`** with one **`RedisStore`** (or other shared `RateLimitStore`) per slot.

### Deployment topology

| Setup | Store | What’s shared | What’s per-process |
|-------|--------|----------------|---------------------|
| Single process | `MemoryStore` | Everything (one process) | N/A |
| Node.js native `cluster` (same host, forked workers) | `ClusterStore` + `ClusterStorePrimary` | Rate limit counters (on primary) | Allowlist, blocklist, penalty |
| PM2 cluster (same host) | `RedisStore` | Rate limit counters | Allowlist, blocklist, penalty |
| Multiple servers + LB | `RedisStore` | Rate limit counters | Allowlist, blocklist, penalty |
| Kubernetes pods | `RedisStore` | Rate limit counters | Allowlist, blocklist, penalty |
| Microservices (one global limit) | `RedisStore` (same namespace/prefix) | Rate limit counters | Allowlist, blocklist, penalty |
| Microservices (per-service limits) | `RedisStore` (different prefix/DB) | Per-service counters | Allowlist, blocklist, penalty |

**PM2 vs Node `cluster`:** **`ClusterStore`** (Node’s native `cluster` IPC with **`ClusterStorePrimary`** on the primary) is **not** for PM2 cluster mode. PM2 runs independent worker processes and uses its own IPC to the daemon, not a Node `cluster` primary/worker tree. For PM2, use **`RedisStore`** (or another shared store). At startup, **`ClusterStore`** detects PM2 (`PM2_HOME` or `pm_id`) and throws a clear error if the process is not a Node cluster worker.

**Sticky sessions:** If your load balancer uses sticky sessions, `MemoryStore` can appear to work, but it is fragile—deploys and restarts reset counters per instance. **`RedisStore` survives restarts** and stays consistent across nodes.

### Auto-detection and warnings

**`detectEnvironment()`** returns flags such as `isKubernetes`, `isDocker`, `isCluster`, `isMultiInstance`, and a **`recommended`** store (`'memory'` | `'redis'`). Use it in your own startup logging or configuration.

```ts
import { detectEnvironment } from 'ratelimit-flex';

const env = detectEnvironment();
if (env.recommended === 'redis' && !process.env.REDIS_URL) {
  console.warn('Production-like environment detected; consider Redis for shared limits.');
}
```

Express and Fastify integrations also call **`warnIfMemoryStoreInCluster`** once at startup: if a **MemoryStore** is used and the process looks like a **multi-instance** environment (e.g. Docker, Kubernetes, PM2), a **one-time** stderr warning is printed.

Suppress with:

```bash
RATELIMIT_FLEX_NO_MEMORY_WARN=1
```

Similarly, if **`RedisStore`** is used **without** an insurance limiter (`resilience.insuranceLimiter`) in a multi-instance-looking environment, a **one-time** stderr reminder suggests **`resilientRedisPreset`** or configuring insurance for failover protection.

Suppress with:

```bash
RATELIMIT_FLEX_NO_RESILIENCE_WARN=1
```

## Presets

Presets return a **`Partial<RateLimitOptions>`** you can pass to `expressRateLimiter` / `fastifyRateLimiter` (or spread and override).

### `singleInstancePreset(options?)`

**When:** Dev, tests, single-process apps.

- Sliding window, **100 req / min** (defaults), in-memory (no `store` in preset—middleware builds `MemoryStore`).

```ts
import { expressRateLimiter, singleInstancePreset } from 'ratelimit-flex';

app.use(expressRateLimiter(singleInstancePreset({ maxRequests: 200 })));
```

### `multiInstancePreset(redisOptions, options?)`

**When:** Production with Redis, multiple workers or nodes.

- `RedisStore`, sliding window, **100 req / min**
- **`onRedisError`:** `fail-open` by default (override via `redisOptions.onRedisError`)

```ts
import { expressRateLimiter, multiInstancePreset } from 'ratelimit-flex';

app.use(
  expressRateLimiter(
    multiInstancePreset({ url: process.env.REDIS_URL! }, { maxRequests: 500 }),
  ),
);
```

### `resilientRedisPreset(redisOptions, options?)`

**When:** Production **Redis** with **insurance** (in-memory fallback), **circuit breaker**, optional **counter sync** on recovery, and per-worker limit scaling. See [Redis resilience](#redis-resilience) for behavior, examples, and comparison with fail-open / fail-closed.

### `clusterPreset(options?)`

**When:** Node.js native `cluster` module (not PM2), single server with multiple CPU cores, no Redis.

- `ClusterStore`, sliding window, **100 req / min**
- Requires `ClusterStorePrimary.init()` on the primary process

```ts
// primary.ts
import cluster from 'node:cluster';
import { ClusterStorePrimary } from 'ratelimit-flex/cluster';

if (cluster.isPrimary) {
  ClusterStorePrimary.init();
  for (let i = 0; i < 4; i++) cluster.fork();
} else {
  await import('./app.js');
}
```

```ts
// app.ts (worker)
import { expressRateLimiter, clusterPreset } from 'ratelimit-flex';

app.use(expressRateLimiter(clusterPreset({ maxRequests: 100, windowMs: 60_000 })));
```

### `queuedClusterPreset(options?)`

**When:** Node.js native `cluster` + **request queuing** (queue over-limit requests instead of rejecting them).

- `ClusterStore` + `expressQueuedRateLimiter` / `fastifyQueuedRateLimiter`
- Sliding window, **100 req / min**, **queue size 100**, **30s max wait**
- Requires `ClusterStorePrimary.init()` on the primary process

```ts
// primary.ts
import cluster from 'node:cluster';
import { ClusterStorePrimary } from 'ratelimit-flex/cluster';

if (cluster.isPrimary) {
  ClusterStorePrimary.init();
  for (let i = 0; i < 4; i++) cluster.fork();
} else {
  await import('./app.js');
}
```

```ts
// app.ts (worker)
import { expressQueuedRateLimiter, queuedClusterPreset } from 'ratelimit-flex';

app.use('/api', expressQueuedRateLimiter(queuedClusterPreset({
  maxRequests: 50,
  windowMs: 60_000,
  maxQueueSize: 200,
})));
```

### `apiGatewayPreset(redisOptions, options?)`

**When:** API gateway–style traffic, key per client credential.

- Token bucket (~**30** tokens/min, **burst 60**), **`x-api-key`** key generator
- **`fail-closed`** when Redis is down (override possible)

```ts
import { expressRateLimiter, apiGatewayPreset } from 'ratelimit-flex';

app.use('/v1', expressRateLimiter(apiGatewayPreset({ url: process.env.REDIS_URL! })));
```

### `authEndpointPreset(redisOptions, options?)`

**When:** Login, signup, password reset—brute-force protection.

- **Fixed window**, **5 req / min** per IP (default), IP-based key
- **`fail-closed`** when Redis is down

```ts
import { expressRateLimiter, authEndpointPreset } from 'ratelimit-flex';

app.post(
  '/login',
  expressRateLimiter(authEndpointPreset({ url: process.env.REDIS_URL! }, { maxRequests: 10 })),
  loginHandler,
);
```

### `publicApiPreset(options?)`

**When:** Public HTTP APIs with a simple in-memory limit and structured JSON errors.

- Sliding window, **60 req / min**, default `message` object

```ts
import { expressRateLimiter, publicApiPreset } from 'ratelimit-flex';

app.use('/public', expressRateLimiter(publicApiPreset()));
```

## Redis failure handling

| Mode | Behavior if Redis errors during quota check |
|------|-----------------------------------------------|
| **`fail-open`** (default for `RedisStore`) | Request is **allowed**; warning logged |
| **`fail-closed`** | Request is treated as **blocked**; middleware responds **503** with `{ error: 'Service temporarily unavailable' }` |

**Recommendation:** **`fail-open`** for most general APIs (availability over strict quota). **`fail-closed`** for auth, payments, or when you must not serve traffic without a working limiter.

```ts
// Fail-open (default)
new RedisStore({ url: REDIS_URL, strategy: RateLimitStrategy.SLIDING_WINDOW, windowMs: 60_000, maxRequests: 100 });

// Fail-closed
new RedisStore({
  url: REDIS_URL,
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
  onRedisError: 'fail-closed',
});
```

**Policy vs counters:** **Allowlist**, **blocklist**, and **penalty box** are enforced in the **RateLimitEngine** (in-memory) **before** the store runs. They **still apply** when Redis is down. Only **quota / window / bucket** counting depends on `RedisStore.increment`.

## Redis resilience

When Redis is unavailable, the default **`fail-open`** / **`fail-closed`** modes either allow every request or block every request globally—there is no per-client quota during the outage. An **insurance limiter** fixes that: a dedicated **`MemoryStore`** that activates automatically when the circuit breaker decides Redis is unhealthy, so each process still enforces **per-process** limits. Configure that in-memory cap as roughly **total shared limit ÷ expected worker count** (e.g. 300 requests/minute across 5 replicas → **60** per process) so failover traffic stays in the same ballpark as your global Redis budget.

### Manual setup (`RedisStore` + `resilience`)

```typescript
import { expressRateLimiter, RedisStore, MemoryStore, RateLimitStrategy } from 'ratelimit-flex';

const insuranceStore = new MemoryStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 60, // 300 / 5 workers
});

const store = new RedisStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 300,
  url: process.env.REDIS_URL!,
  resilience: {
    insuranceLimiter: { store: insuranceStore },
    circuitBreaker: { failureThreshold: 3, recoveryTimeMs: 5000 },
    hooks: {
      onFailover: (err) => console.error('Redis down, using fallback', err),
      onRecovery: (ms) => console.log(`Redis recovered after ${ms}ms`),
    },
  },
});

app.use(expressRateLimiter({ store, strategy: RateLimitStrategy.SLIDING_WINDOW }));
```

### Preset (`resilientRedisPreset`)

`resilientRedisPreset` wires the same idea—**Redis** + **insurance `MemoryStore`** + **circuit breaker**—and estimates worker count from the environment (or `estimatedWorkers`) so you do not hand-divide limits yourself:

```typescript
import { expressRateLimiter, resilientRedisPreset } from 'ratelimit-flex';

app.use(expressRateLimiter(
  resilientRedisPreset(
    { url: process.env.REDIS_URL! },
    { maxRequests: 300, estimatedWorkers: 5 }
  )
));
```

### Circuit breaker

The breaker around Redis has three states:

- **Closed** — Redis is used; successes reset failure streaks.
- **Open** — Too many consecutive failures; requests are **not** sent to Redis (they go to the insurance store instead), avoiding wasted round-trips to a dead server.
- **Half-open** — After a recovery window, a probe allows one Redis attempt; success **closes** the circuit, failure **reopens** it.

### Counter sync

When the circuit **closes** again after an outage, accumulated hits in the insurance **`MemoryStore`** can be **replayed into Redis** (`INCRBY`-style paths per strategy) so shared state catches up. This is **`syncOnRecovery: true`** by default on `resilience.insuranceLimiter` and can be set to **`false`** if you do not want that merge step.

**Sliding window note:** replay bulk-inserts synthetic hits with timestamps at recovery time (counts match; the visible window is not time-smoothed across the outage — see JSDoc on `RedisStore` sync). **Fixed window** and **token bucket** sync paths behave as described in code comments.

### Comparison: fail-open / fail-closed vs insurance limiter

| Feature | fail-open / fail-closed | Insurance limiter |
|---------|------------------------|-------------------|
| Redis down behavior | Allow all or block all | Fallback to in-memory rate limiting |
| Rate limiting during outage | None (open) or total block (closed) | Per-process limits enforced |
| Circuit breaker | No | Yes — avoids wasted Redis round-trips |
| Counter sync on recovery | No | Yes — replays in-memory hits to Redis |
| Observability hooks | onRedisError only | onFailover, onRecovery, onCircuitOpen, onCircuitClose, onInsuranceHit, onCounterSync |

When insurance is configured, it **replaces** the binary fail-open/fail-closed behavior for quota operations (see [Redis failure handling](#redis-failure-handling)).

**HTTP:** middleware sets **`X-RateLimit-Store: fallback`** when `storeUnavailable` is true (insurance path) so monitors can tell primary Redis from fallback.

## Metrics & Observability

You get production-grade observability for free — just flip a switch (`metrics: true`) on **Express** (`expressRateLimiter`) or **Fastify** (`fastifyRateLimiter` from `ratelimit-flex/fastify`). The same `RateLimitOptions.metrics` / `MetricsConfig` applies to both; only the **surface API** differs (handler methods vs. Fastify decorations — see below).

### Why metrics matter for rate limiting

Rate limiters are invisible infrastructure: when they work, nobody notices; when they misconfigure or drift, they either let attacks through or frustrate legitimate users. Metrics make the invisible visible — throughput, block rates, latency, and hot keys — so you can tune limits, catch abuse, and prove SLAs.

### Quick start

**Express** — the middleware is also a metrics handle (`getMetricsSnapshot`, `on('metrics', …)`, etc.):

```ts
const limiter = expressRateLimiter({ maxRequests: 100, metrics: true });
app.get('/stats', (req, res) => res.json(limiter.getMetricsSnapshot()));
```

**Fastify** — same `RateLimitOptions.metrics`; the plugin decorates the instance when metrics are enabled (`rateLimitMetrics`, `getMetricsSnapshot`, `getMetricsHistory`, `on('metrics', …)` on `rateLimitMetrics`):

```ts
await app.register(fastifyRateLimiter, { maxRequests: 100, metrics: true });
app.get('/stats', async (request, reply) => {
  const snap = app.getMetricsSnapshot?.() ?? null;
  return reply.send(snap ?? { message: 'No snapshot yet' });
});
```

**Framework API (same metrics, different wiring):**

| Surface | Express (`expressRateLimiter`) | Fastify (`fastifyRateLimiter`) |
|--------|-------------------------------|--------------------------------|
| Metrics manager | `limiter.metricsManager` | `app.rateLimitMetrics` |
| Latest / history | `limiter.getMetricsSnapshot()`, `getMetricsHistory()` | `app.getMetricsSnapshot?.()`, `getMetricsHistory?.()` |
| `metrics` events | `limiter.on('metrics', …)` | `app.rateLimitMetrics?.on('metrics', …)` |
| Prometheus `GET` | `limiter.metricsEndpoint` → `app.use('/metrics', …)` | `app.fastifyMetricsRoute` → `app.get('/metrics', …)` (native; `metricsEndpoint` still available for `@fastify/express`) |
| Clean shutdown | `limiter.shutdownMetrics()` | Plugin **`onClose`** calls `metricsManager.shutdown()`; optional `await app.rateLimitMetrics?.shutdown()` |

### What’s collected

Aggregated snapshots (and Prometheus / OpenTelemetry exporters when enabled) expose the following concepts. **Prometheus** metric names use the default prefix `ratelimit_` (configurable). **OpenTelemetry** uses `{prefix}_…` with default prefix `ratelimit` (e.g. `ratelimit_requests_total`). Prometheus also emits **`ratelimit_requests_skipped_total`** and **`ratelimit_requests_allowlisted_total`** as separate counters.

| Metric (concept / series) | Type | Description |
|---------------------------|------|-------------|
| `requests_total` | Counter | Total requests by **status** and **reason** (allowed, blocked: rate_limit, blocklist, penalty, service_unavailable; skipped / allowlisted where applicable) |
| `middleware_duration_ms` / `middleware_duration_milliseconds` | Histogram | Time spent in the rate limiter middleware per request (ms) |
| `store_duration_ms` / `store_duration_milliseconds` | Histogram | Store `increment` latency (e.g. Redis) per operation (ms) |
| `requests_per_second` | Gauge | Estimated throughput over the aggregation window |
| `block_rate` | Gauge | Share of requests blocked (0–1) over the window |
| `hot_key_hits` | Gauge | Top keys by hit count (cardinality capped; label `key`) |

### Performance guarantee

Metrics collection adds **less than ~2 microseconds per request** on typical hardware. Recording is **synchronous** — numeric increments and fixed ring buffers only: **no allocations** and **no I/O** on the request path. Aggregation runs on a **background timer** (default: every **10 seconds**).

### Callback / Event-based metrics

**Push — `onMetrics` callback** (fires each aggregation tick; same option for Express and Fastify):

Express:

```ts
expressRateLimiter({
  maxRequests: 100,
  windowMs: 60_000,
  metrics: {
    enabled: true,
    onMetrics: (snapshot) => {
      if (snapshot.window.blockRate > 0.1) console.warn('High block rate', snapshot);
    },
  },
});
```

Fastify:

```ts
import { fastifyRateLimiter } from 'ratelimit-flex/fastify';

await app.register(fastifyRateLimiter, {
  maxRequests: 100,
  windowMs: 60_000,
  metrics: {
    enabled: true,
    onMetrics: (snapshot) => {
      if (snapshot.window.blockRate > 0.1) console.warn('High block rate', snapshot);
    },
  },
});
```

**Events — `on('metrics', …)`** (same snapshots as `onMetrics`):

Express — on the middleware handler:

```ts
const limiter = expressRateLimiter({ maxRequests: 100, metrics: true });
limiter.on('metrics', (snapshot) => {
  /* same shape as onMetrics */
});
```

Fastify — on `rateLimitMetrics` (a `MetricsManager`; only present when metrics are enabled):

```ts
await app.register(fastifyRateLimiter, { maxRequests: 100, metrics: true });
app.rateLimitMetrics?.on('metrics', (snapshot) => {
  /* same shape as onMetrics */
});
```

**Pull — latest snapshot** (`null` before the first aggregation tick):

Express:

```ts
const snap = limiter.getMetricsSnapshot();
res.json(snap ?? { message: 'No snapshot yet' });
```

Fastify — the plugin decorates **`getMetricsSnapshot`** and **`getMetricsHistory`** on the instance:

```ts
const snap = app.getMetricsSnapshot?.() ?? null;
return reply.send(snap ?? { message: 'No snapshot yet' });
```

### Prometheus integration

**Standalone (Express)** — text exposition **without** installing `prom-client`; use the middleware from the limiter:

```ts
const limiter = expressRateLimiter({
  maxRequests: 100,
  metrics: { enabled: true, prometheus: { enabled: true } },
});
if (limiter.metricsEndpoint) {
  app.use('/metrics', limiter.metricsEndpoint);
}
```

**Standalone (Fastify)** — use the **native** route handler (no Express adapter):

```ts
await app.register(fastifyRateLimiter, {
  maxRequests: 100,
  metrics: { enabled: true, prometheus: { enabled: true } },
});
if (app.fastifyMetricsRoute) {
  app.get('/metrics', app.fastifyMetricsRoute);
}
```

(`metricsEndpoint` is still set for apps that mount Express middleware via `@fastify/express` / `middie`; prefer `fastifyMetricsRoute` for plain Fastify.)

**With an existing `prom-client` registry** — pass your `Registry`; scrape your global `/metrics` as usual.

Express:

```ts
import { Registry } from 'prom-client';

const registry = new Registry();
expressRateLimiter({
  maxRequests: 100,
  metrics: { enabled: true, prometheus: { enabled: true, registry } },
});
```

Fastify (same `metrics` object; register the plugin, then mount `/metrics` with `fastifyMetricsRoute` as above):

```ts
import { Registry } from 'prom-client';
import { fastifyRateLimiter } from 'ratelimit-flex/fastify';

const registry = new Registry();
await app.register(fastifyRateLimiter, {
  maxRequests: 100,
  metrics: { enabled: true, prometheus: { enabled: true, registry } },
});
if (app.fastifyMetricsRoute) {
  app.get('/metrics', app.fastifyMetricsRoute);
}
```

**Example PromQL / Grafana queries:**

```promql
sum(rate(ratelimit_requests_total{status="blocked"}[5m]))
```

```promql
histogram_quantile(
  0.99,
  sum(rate(ratelimit_middleware_duration_milliseconds_bucket[5m])) by (le)
)
```

### OpenTelemetry integration

Pass a **`Meter`** from `@opentelemetry/api` (optional peer dependency). Works with any **OTLP-compatible** backend — **Grafana Cloud**, **Datadog**, **New Relic**, **Honeycomb**, self-hosted collectors, etc.

Express:

```ts
import { metrics } from '@opentelemetry/api';
import { expressRateLimiter } from 'ratelimit-flex';

const meter = metrics.getMeter('my-service');
app.use(
  expressRateLimiter({
    maxRequests: 100,
    metrics: { enabled: true, openTelemetry: { enabled: true, meter, prefix: 'ratelimit' } },
  }),
);
```

Fastify:

```ts
import { metrics } from '@opentelemetry/api';
import { fastifyRateLimiter } from 'ratelimit-flex/fastify';

const meter = metrics.getMeter('my-service');
await app.register(fastifyRateLimiter, {
  maxRequests: 100,
  metrics: { enabled: true, openTelemetry: { enabled: true, meter, prefix: 'ratelimit' } },
});
```

On shutdown, call **`limiter.openTelemetryAdapter?.shutdown()`** (Express) or **`app.rateLimitMetrics?.getOpenTelemetryAdapter()?.shutdown()`** (Fastify) if you need to tear down observable gauge callbacks cleanly. The Fastify plugin also runs **`metricsManager.shutdown()`** on `onClose`.

### Snapshot API

**`MetricsSnapshot`** (from the collector; `getMetricsSnapshot()` returns the latest):

```ts
interface MetricsSnapshot {
  readonly timestamp: Date;
  readonly window: {
    readonly durationMs: number;
    readonly requestsPerSecond: number;
    readonly blocksPerSecond: number;
    readonly blockRate: number;
    readonly allowRate: number;
  };
  readonly totals: {
    readonly requests: number;
    readonly allowed: number;
    readonly blocked: number;
    readonly skipped: number;
    readonly allowlisted: number;
  };
  readonly blockReasons: {
    readonly rateLimit: number;
    readonly blocklist: number;
    readonly penalty: number;
    readonly serviceUnavailable: number;
  };
  readonly latency: {
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly stdDev: number;
  };
  readonly storeLatency: {
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
  };
  readonly hotKeys: ReadonlyArray<{ readonly key: string; readonly hits: number; readonly blocked: number }>;
  readonly trends: {
    readonly requestRateTrend: 'increasing' | 'decreasing' | 'stable';
    readonly blockRateTrend: 'increasing' | 'decreasing' | 'stable';
    readonly latencyTrend: 'increasing' | 'decreasing' | 'stable';
  };
  readonly latencySamplesMs?: readonly number[];
  readonly storeLatencySamplesMs?: readonly number[];
}
```

**Alerting — block rate above a threshold:**

Express:

```ts
limiter.on('metrics', (s) => {
  if (s.window.blockRate > 0.25) {
    void alerting.notify('Block rate above 25%', { blockRate: s.window.blockRate });
  }
});
```

Fastify:

```ts
app.rateLimitMetrics?.on('metrics', (s) => {
  if (s.window.blockRate > 0.25) {
    void alerting.notify('Block rate above 25%', { blockRate: s.window.blockRate });
  }
});
```

**Logging hot keys (abuse / capacity planning):**

Express:

```ts
limiter.on('metrics', (s) => {
  for (const row of s.hotKeys.slice(0, 5)) {
    logger.info({ key: row.key, hits: row.hits, blocked: row.blocked }, 'top rate-limit key');
  }
});
```

Fastify:

```ts
app.rateLimitMetrics?.on('metrics', (s) => {
  for (const row of s.hotKeys.slice(0, 5)) {
    logger.info({ key: row.key, hits: row.hits, blocked: row.blocked }, 'top rate-limit key');
  }
});
```

### Trends

The collector compares **recent vs earlier** samples in a sliding window (request rate, block rate, mean latency) and labels each series **`increasing`**, **`decreasing`**, or **`stable`**. Use **`snapshot.trends.*`** for proactive alerts (e.g. rising block rate before user complaints, or rising latency before timeouts).

### MetricsConfig reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | — | **Required** when using object form; master switch |
| `intervalMs` | `number` | `10000` | Aggregation / emit interval (ms) |
| `topKSize` | `number` | `20` | How many hot keys to keep in snapshots |
| `histogramBuckets` | `number[]` | (library defaults) | Upper bounds (ms) for latency histograms |
| `onMetrics` | `(snapshot: MetricsSnapshot) => void` | — | Called each tick with the latest snapshot |
| `prometheus` | `{ enabled: boolean; prefix?: string; registry?: unknown }` | — | Prometheus text + optional `prom-client` registry |
| `openTelemetry` | `{ enabled: boolean; meter?: unknown; prefix?: string }` | — | OTel instruments via user-supplied `Meter` |

Use **`metrics: true`** as shorthand for `{ enabled: true }` with the defaults above. **Express:** call **`shutdownMetrics()`** on the middleware handler when the process exits (alongside store shutdown). **Fastify:** the plugin registers **`onClose`** to stop the collector and adapters when the server closes; call **`await app.rateLimitMetrics?.shutdown()`** only if you need an explicit teardown without closing Fastify.

---

## Configuration reference

Options are merged with strategy defaults. Omit **`store`** to get an auto-created **`MemoryStore`** (unless you use **`limits`**, which builds grouped in-memory stores).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `strategy` | `RateLimitStrategy` | `SLIDING_WINDOW` | `SLIDING_WINDOW`, `FIXED_WINDOW`, `TOKEN_BUCKET` |
| `store` | `RateLimitStore` | auto `MemoryStore` | Backing store |
| `windowMs` | `number` | `60000` | Window length (sliding / fixed) |
| `maxRequests` | `number` \| `(req) => number` | `100` | Max requests per window (sliding / fixed) |
| `incrementCost` | `number` \| `(req) => number` | — | Quota units per request (`1` if omitted); use with weighted `store.increment` semantics |
| `limits` | `{ windowMs, max }[]` | — | Multiple windows; block if **any** exceeded ([details](#multi-window-limits-limits)) |
| `tokensPerInterval` | `number` | `10` | Token bucket refill rate |
| `interval` | `number` | `60000` | Refill interval (token bucket) |
| `bucketSize` | `number` | `100` | Max tokens / burst (token bucket) |
| `keyGenerator` | `(req) => string` | IP / socket fallback | Storage key ([Client IP & reverse proxies](#client-ip-and-reverse-proxies)) |
| `headers` | `boolean` | `true` | Legacy `X-RateLimit-*` when **`standardHeaders`** is omitted; see [Standard headers](#standard-headers) |
| `standardHeaders` | `boolean` \| `'legacy'` \| `'draft-6'` \| `'draft-7'` \| `'draft-8'` | (see defaults) | Which response header profile to send ([Standard headers](#standard-headers)) |
| `identifier` | `string` | `{limit}-per-{windowSeconds}` | Policy name for draft-8 / draft-7 policy strings |
| `legacyHeaders` | `boolean` | (profile-dependent) | Also emit `X-RateLimit-*` alongside draft profiles |
| `statusCode` | `number` | `429` | Status when rate-limited |
| `message` | `string` \| `object` | `"Too many requests"` | Response body (`{ error: message }`) |
| `skip` | `(req) => boolean` | — | Skip limiting |
| `skipFailedRequests` | `boolean` | `false` | Decrement on `>= 400` responses |
| `skipSuccessfulRequests` | `boolean` | `false` | Decrement on `< 400` responses |
| `onLimitReached` | `(req, result) => void` | — | After a block |
| `metrics` | `MetricsConfig` \| `boolean` | — | Aggregated metrics, Prometheus, OTel ([Metrics & Observability](#metrics--observability)) |
| `allowlist` | `string[]` | — | Keys that skip limiting |
| `blocklist` | `string[]` | — | Keys rejected before quota (`403` default) |
| `blocklistStatusCode` | `number` | `403` | Status for blocklist |
| `blocklistMessage` | `string` \| `object` | `"Forbidden"` | Blocklist body |
| `penaltyBox` | `PenaltyBoxOptions` | — | Ban after repeated violations |
| `draft` | `boolean` | `false` | Observe would-be blocks without enforcing |
| `onDraftViolation` | `(req, result) => void` | — | When `draft` and would block |

**Penalty box**

| Field | Type | Description |
|-------|------|-------------|
| `violationsThreshold` | `number` | Blocks needed to trigger penalty |
| `violationWindowMs` | `number` | `3600000` default | Sliding window for violation count |
| `penaltyDurationMs` | `number` | — | How long the ban lasts |
| `onPenalty` | `(req) => void` | Optional callback |

**RedisStore**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `client` | `RedisLikeClient` | — | Existing client (xor `url`) |
| `url` | `string` | — | Redis URL (needs `ioredis` for dynamic connect) |
| `keyPrefix` | `string` | `"rlf:"` | Key prefix |
| `onRedisError` | `'fail-open'` \| `'fail-closed'` | `fail-open` | Behavior when Redis fails during increment |
| `onWarn` | `(msg, err?) => void` | `console.warn` | Custom logging |

## Standard headers

Express and Fastify attach rate-limit response headers via **`standardHeaders`**, **`headers`**, **`identifier`**, and **`legacyHeaders`**. The **`formatRateLimitHeaders()`** helper is also exported for custom middleware. See the IETF draft: **[RateLimit header fields for HTTP](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)**.

### Quick comparison

| Option | Headers sent | Format |
|--------|-------------|--------|
| `standardHeaders: 'legacy'` or `headers: true` (and `standardHeaders` omitted) | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` | Legacy (epoch timestamp) |
| `standardHeaders: 'draft-6'` | `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `RateLimit-Policy` | IETF draft-6 (seconds) |
| `standardHeaders: 'draft-7'` | `RateLimit` (combined), `RateLimit-Policy` | IETF draft-7 (structured fields) |
| `standardHeaders: 'draft-8'` | `RateLimit` (named policy), `RateLimit-Policy` | IETF draft-8 (latest) |
| `standardHeaders: false` | None | — |

On **429** (and other blocked responses where headers are enabled), **`Retry-After`** is included in seconds until reset — for legacy and draft profiles.

**Note:** If the store’s **`resetTime`** is already in the past when headers are formatted (clock skew, slow handling), the seconds-until-reset value is **0**, so you may see **`Retry-After: 0`**. RFC 7231 defines that as “retry immediately” (valid); some clients treat **`0`** as no backoff and may retry aggressively — not a spec violation, but worth knowing for operators.

**Grouped windows (`limits`):** policy metadata uses the **shortest** window length for **`w=`** and **`getLimit`**’s **minimum** cap across windows, so **`RateLimit-Policy`** / default **`identifier`** read like a single-window policy. That is a reasonable approximation but can mislead if you rely on headers to document a multi-window ruleset — set **`identifier`** (and document behavior out-of-band) when that matters. The shorthand **`limits`** array builds **in-memory** stores only; for shared counters across replicas, see [Multi-window limits (`limits`)](#multi-window-limits-limits).

### Example

```ts
import expressRateLimiter from 'ratelimit-flex';

// Recommended for new APIs
app.use(expressRateLimiter({
  maxRequests: 100,
  windowMs: 60_000,
  standardHeaders: 'draft-8',
  identifier: 'api-v1',
}));

// Response headers:
// RateLimit-Policy: "api-v1";q=100;w=60
// RateLimit: "api-v1";r=95;t=45
// (Retry-After: 45  ← only on 429)
```

### Migration from express-rate-limit

The **`standardHeaders`** string values (`'draft-6'`, `'draft-7'`, `'draft-8'`) are intentionally aligned with **express-rate-limit**’s option names so you can migrate without renaming profiles. **`fromExpressRateLimitOptions()`** (exported from the main package) maps **`max` → `maxRequests`** and header flags. See [From `express-rate-limit`](#from-express-rate-limit).

## Advanced features

### Client IP and reverse proxies

The default storage key comes from **`defaultKeyGenerator`**: it prefers **`req.ip`**, then **`socket.remoteAddress`**, else **`"unknown"`**. Behind one or more reverse proxies or load balancers, the connection’s **`remoteAddress`** is often the **proxy**, not the end client. If **`req.ip`** is not derived from **`X-Forwarded-For`** (or your platform’s equivalent), every user can appear as the **same** key — too strict for real clients, or too loose for abusers sharing a proxy.

**Express** — Set [`trust proxy`](https://expressjs.com/en/guide/behind-proxies.html) so **`req.ip`** reflects the client (e.g. `app.set('trust proxy', 1)` or a hop count / subnet list that matches your deployment).

**Fastify** — Set [`trustProxy`](https://fastify.dev/docs/latest/Reference/Server/#trustproxy) on the server so the request’s IP used by plugins matches the real client.

Alternatively, stop relying on IP for identity: set **`keyGenerator`** to a stable per-user or per-tenant id (session, JWT subject, API key header), which is often clearer than parsing forwarded headers yourself.

**Per-user / per-key limiting** — Set `keyGenerator` (API key, user id, tenant).

```ts
app.use(
  expressRateLimiter({
    maxRequests: 100,
    windowMs: 60_000,
    keyGenerator: (req) =>
      String((req as import('express').Request).header('x-api-key') ?? 'anonymous'),
  }),
);
```

**Global + per-route** — Register multiple middlewares with different options.

```ts
app.use(expressRateLimiter({ maxRequests: 100, windowMs: 60_000 }));
app.use('/login', expressRateLimiter({ maxRequests: 5, windowMs: 60_000 }));
```

### Multi-window limits (`limits`)

Apply **several** sliding or fixed windows at once: a request is blocked if **any** window is exceeded. Pass **`limits`** as an array of **`{ windowMs, max }`** (merged to **`groupedWindowStores`** internally):

```ts
import { expressRateLimiter, RateLimitStrategy } from 'ratelimit-flex';

app.use(
  expressRateLimiter({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    limits: [
      { windowMs: 60_000, max: 30 },
      { windowMs: 3_600_000, max: 500 },
    ],
  }),
);
```

**Horizontal scale:** That shorthand creates **one `MemoryStore` per window** in each Node process. Behind multiple app instances, each replica keeps **its own** counters, so effective limits are **per process**, not global. To enforce the same multi-window policy cluster-wide, omit **`limits`** and set **`groupedWindowStores`** explicitly: one entry per window, each with a **`store`** that points at a shared backend (typically **`RedisStore`** with the same **`windowMs`** / **`maxRequests`** as the slot). Single-instance or dev setups can keep using **`limits`** as-is.

**Binding slot:** For headers and **`getLimit`**, the engine picks one **binding** window among grouped slots. If the request is **blocked**, that is the blocking window with the **latest** **`resetTime`** when several windows block at once. If the request is **allowed**, the binding slot is the one with the **lowest absolute** **`remaining`** count — **not** “most exhausted” as a **percentage** of each window’s cap. That matches typical setups (e.g. a tight per-minute cap next to a loose per-hour cap). Unusual mixes where a **higher** limit has **fewer** tokens left in absolute terms could label a different slot as “most constrained” than a **%-of-limit** rule would.

**Dynamic limits** — `maxRequests` as a function (window strategies).

```ts
app.use(
  expressRateLimiter({
    windowMs: 60_000,
    maxRequests: (req) =>
      (req as import('express').Request).user?.isPremium ? 1000 : 100,
  }),
);
```

**Weighted / cost-based limits** — see [Weighted / cost-based rate limiting](#weighted--cost-based-rate-limiting) (`incrementCost` or `store.increment(..., { cost })`).

**Allowlist / blocklist**

```ts
app.use(
  expressRateLimiter({
    allowlist: ['203.0.113.10'],
    blocklist: ['bad-key'],
    keyGenerator: (req) => String((req as import('express').Request).header('x-api-key') ?? 'anon'),
  }),
);
```

**Penalty box**

```ts
app.use(
  expressRateLimiter({
    maxRequests: 10,
    windowMs: 60_000,
    penaltyBox: {
      violationsThreshold: 5,
      violationWindowMs: 3_600_000,
      penaltyDurationMs: 900_000,
    },
  }),
);
```

**Custom error responses** — `statusCode`, `message`, `blocklistMessage`, etc.

```ts
app.use(
  expressRateLimiter({
    maxRequests: 10,
    windowMs: 60_000,
    statusCode: 429,
    message: { error: 'Slow down', code: 'RATE_LIMIT' },
  }),
);
```

**Skipping routes** — `skip(req)`.

```ts
app.use(
  expressRateLimiter({
    maxRequests: 100,
    windowMs: 60_000,
    skip: (req) => String((req as { path?: string }).path ?? '').startsWith('/health'),
  }),
);
```

## Custom stores

Implement **`RateLimitStore`**:

```ts
export interface RateLimitIncrementOptions {
  maxRequests?: number;
  /** Quota units consumed by this call (default 1). */
  cost?: number;
}

export interface RateLimitDecrementOptions {
  /** Must match the `cost` of the increment being rolled back. */
  cost?: number;
}

export interface RateLimitStore {
  increment(
    key: string,
    options?: RateLimitIncrementOptions,
  ): Promise<{
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
    storeUnavailable?: boolean;
  }>;
  decrement(key: string, options?: RateLimitDecrementOptions): Promise<void>;
  reset(key: string): Promise<void>;
  shutdown(): Promise<void>;
}
```

Use **`increment`’s optional `{ maxRequests }`** for dynamic caps on window strategies, and **`{ cost }`** for weighted requests. Implement **`decrement`** with the same **`cost`** when your integration rolls back a weighted increment. Back your store with PostgreSQL, DynamoDB, etc., if you need persistence without Redis—mind latency and atomicity for hot keys.

Pass your store as **`store`** in middleware options.

## API reference

| Export | Role |
|--------|------|
| **`expressRateLimiter(options)`** | Express middleware factory (`Partial<RateLimitOptions>`) |
| **`fastifyRateLimiter`** | From `ratelimit-flex/fastify` — Fastify plugin |
| **`createStore(options)`** | Build `MemoryStore` or `RedisStore` (`CreateStoreOptions`) |
| **`detectEnvironment()`** | `EnvironmentInfo` — deployment hints |
| **`singleInstancePreset`**, **`multiInstancePreset`**, **`resilientRedisPreset`**, **`apiGatewayPreset`**, **`authEndpointPreset`**, **`publicApiPreset`** | Opinionated `Partial<RateLimitOptions>` |
| **`CircuitBreaker`**, **`RedisResilienceOptions`**, **`ResilienceHooks`**, **`InsuranceLimiterOptions`**, **`CircuitBreakerOptions`**, **`CircuitState`** | Circuit breaker and Redis failover types ([Redis resilience](#redis-resilience)) |
| **`MemoryStore`** | In-memory store (`getActiveKeys` / `resetAll` for advanced sync scenarios) |
| **`RedisStore`** | Redis-backed store (Lua); optional **`resilience`** for insurance + breaker |
| **`RateLimitEngine`**, **`createRateLimitEngine`** | Core engine without HTTP |
| **`resolveIncrementOpts`**, **`matchingDecrementOptions`** | Resolve per-request `increment` / `decrement` options (weighted limits) |
| **`createRateLimiter`** | `{ express }` middleware helper |
| **`MetricsManager`**, **`normalizeMetricsConfig`**, **`PrometheusAdapter`**, **`OpenTelemetryAdapter`** | Metrics wiring and exporters ([Metrics & Observability](#metrics--observability)) |

Default export = **`expressRateLimiter`**.

## Migration guide

Options are the same **`RateLimitOptions`** shape for **`expressRateLimiter`** and **`fastifyRateLimiter`**; only the import path and how you mount the integration differ (see [Quick Start](#quick-start)).

### From `express-rate-limit`

| express-rate-limit | ratelimit-flex |
|--------------------|----------------|
| `max` | `maxRequests` |
| `windowMs` | `windowMs` (unchanged) |
| `standardHeaders: true` | `standardHeaders: 'draft-6'` (or use the helper below) |
| `standardHeaders: false` | `standardHeaders: false` |
| `standardHeaders: 'draft-6'` \| `'draft-7'` \| `'draft-8'` | Same string values |
| `legacyHeaders` | `legacyHeaders` |
| `headers: true` (older API) | Prefer `standardHeaders: 'legacy'` or explicit draft profile |

Use **`fromExpressRateLimitOptions()`** (exported from **`ratelimit-flex`**) to map **`max` → `maxRequests`** and express-rate-limit **`standardHeaders`** / **`legacyHeaders`** semantics in one call:

```ts
import expressRateLimiter, { fromExpressRateLimitOptions } from 'ratelimit-flex';

// express-rate-limit:
// rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true })

app.use(
  expressRateLimiter(
    fromExpressRateLimitOptions({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
    }),
  ),
);
```

Equivalent manual mapping:

```ts
import { expressRateLimiter } from 'ratelimit-flex';

app.use(
  expressRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 100,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
  }),
);
```

Default export is **`expressRateLimiter`** (same as named import). For **Redis** across instances, use **`RedisStore`**, **`multiInstancePreset`**, or **`resilientRedisPreset`** and wire **`url`** or **`client`** as in [Deployment guide](#deployment-guide).

### From `@fastify/rate-limit`

| `@fastify/rate-limit` | ratelimit-flex (`ratelimit-flex/fastify`) |
|----------------------|-------------------------------------------|
| `max` | `maxRequests` |
| `timeWindow` (ms number) | `windowMs` (same numeric value) |
| `timeWindow` (`'1 minute'` etc. via [`ms`](https://github.com/vercel/ms)) | `windowMs` — convert to milliseconds (e.g. `60_000` for one minute, or `import ms from 'ms'; ms('1 minute')`) |
| `allowList` | `allowlist` |
| `keyGenerator(request)` | `keyGenerator` — same idea; signature is **`(req: unknown) => string`** (pass your Fastify `request`) |
| `redis` / `nameSpace` | Use **`RedisStore`** with **`url`** / **`client`** and **`keyPrefix`** (see [When to use RedisStore](#when-to-use-redisstore)) |
| `skip` / `skipOnError` | `skip` — for Redis errors, configure **`onRedisError`** on **`RedisStore`** ([Redis failure handling](#redis-failure-handling)) |
| `errorResponseBuilder` | `message` / `statusCode` |
| `enableDraftSpec: true` | `standardHeaders: 'draft-6'` (or a newer draft profile) |
| `ban` / `onBanReach` | No single drop-in — use **`penaltyBox`**, **`blocklist`**, or custom handlers as needed |
| Per-route `fastify.rateLimit({ ... })` | Register scoped plugins or use different **`RateLimitOptions`** per route / plugin scope |

```ts
// @fastify/rate-limit
// await fastify.register(import('@fastify/rate-limit'), { max: 100, timeWindow: '1 minute' });

// ratelimit-flex
import { fastifyRateLimiter } from 'ratelimit-flex/fastify';

await fastify.register(fastifyRateLimiter, {
  maxRequests: 100,
  windowMs: 60_000,
});
```

**`global: false`** in `@fastify/rate-limit` limits encapsulation to routes registered in that plugin’s scope. Achieve the same by registering **`fastifyRateLimiter`** in a [Fastify plugin encapsulation](https://fastify.dev/docs/latest/Reference/Plugins/) context (child instance) instead of the root app.

## Contributing

1. Clone the repo and run **`npm install`**
2. **`npm test`** — Vitest
3. **`npm run lint`** — ESLint
4. **`npm run build`** — TypeScript (`dist/`)

Open a PR with a short description of behavior changes and any new tests.

## License

MIT
