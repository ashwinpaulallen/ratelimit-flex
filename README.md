# ratelimit-flex

Flexible, TypeScript-first rate limiting for Node.js with Express and Fastify.

[![npm version](https://img.shields.io/npm/v/ratelimit-flex.svg)](https://www.npmjs.com/package/ratelimit-flex)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
![Tests](https://img.shields.io/badge/tests-vitest%20passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-First-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)

- **Three strategies:** sliding window, token bucket, fixed window
- **Frameworks:** Express and Fastify (separate entry for Fastify to keep bundles lean)
- **Stores:** `MemoryStore` (in-process) and `RedisStore` (shared, Lua-backed)
- **TypeScript-first:** strict types, discriminated options where it matters
- **Redis resilience:** `fail-open` or `fail-closed` when Redis is unavailable
- **Metrics & observability (Express & Fastify):** aggregated snapshots, Prometheus, OpenTelemetry — `metrics: true`
- **Presets:** `singleInstancePreset`, `multiInstancePreset`, `apiGatewayPreset`, `authEndpointPreset`, `publicApiPreset`

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

**Node.js:** `>= 18` (see `package.json` `engines`).

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

### Deployment topology

| Setup | Store | What’s shared | What’s per-process |
|-------|--------|----------------|---------------------|
| Single process | `MemoryStore` | Everything (one process) | N/A |
| PM2 cluster (same host) | `RedisStore` | Rate limit counters | Allowlist, blocklist, penalty |
| Multiple servers + LB | `RedisStore` | Rate limit counters | Allowlist, blocklist, penalty |
| Kubernetes pods | `RedisStore` | Rate limit counters | Allowlist, blocklist, penalty |
| Microservices (one global limit) | `RedisStore` (same namespace/prefix) | Rate limit counters | Allowlist, blocklist, penalty |
| Microservices (per-service limits) | `RedisStore` (different prefix/DB) | Per-service counters | Allowlist, blocklist, penalty |

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
| `limits` | `{ windowMs, max }[]` | — | Multiple windows; block if **any** exceeded |
| `tokensPerInterval` | `number` | `10` | Token bucket refill rate |
| `interval` | `number` | `60000` | Refill interval (token bucket) |
| `bucketSize` | `number` | `100` | Max tokens / burst (token bucket) |
| `keyGenerator` | `(req) => string` | IP / socket fallback | Storage key |
| `headers` | `boolean` | `true` | `X-RateLimit-*`, `Retry-After` |
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

## Advanced features

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
  decrement(key: string): Promise<void>;
  reset(key: string): Promise<void>;
  shutdown(): Promise<void>;
}
```

Use **`increment`’s optional `{ maxRequests }`** for dynamic caps on window strategies. Back your store with PostgreSQL, DynamoDB, etc., if you need persistence without Redis—mind latency and atomicity for hot keys.

Pass your store as **`store`** in middleware options.

## API reference

| Export | Role |
|--------|------|
| **`expressRateLimiter(options)`** | Express middleware factory (`Partial<RateLimitOptions>`) |
| **`fastifyRateLimiter`** | From `ratelimit-flex/fastify` — Fastify plugin |
| **`createStore(options)`** | Build `MemoryStore` or `RedisStore` (`CreateStoreOptions`) |
| **`detectEnvironment()`** | `EnvironmentInfo` — deployment hints |
| **`singleInstancePreset`**, **`multiInstancePreset`**, **`apiGatewayPreset`**, **`authEndpointPreset`**, **`publicApiPreset`** | Opinionated `Partial<RateLimitOptions>` |
| **`MemoryStore`** | In-memory store |
| **`RedisStore`** | Redis-backed store (Lua) |
| **`RateLimitEngine`**, **`createRateLimitEngine`** | Core engine without HTTP |
| **`createRateLimiter`** | `{ express }` middleware helper |
| **`MetricsManager`**, **`normalizeMetricsConfig`**, **`PrometheusAdapter`**, **`OpenTelemetryAdapter`** | Metrics wiring and exporters ([Metrics & Observability](#metrics--observability)) |

Default export = **`expressRateLimiter`**.

## Migration guide

### From `express-rate-limit`

`express-rate-limit` uses **`max`**; ratelimit-flex uses **`maxRequests`**. Map **`windowMs`** the same.

```ts
// express-rate-limit
// rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true })

// ratelimit-flex
expressRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 100,
  headers: true,
});
```

For a **Redis** store, use **`RedisStore`** or **`multiInstancePreset`**, not the old `store: new RedisStore(...)` from third-party wrappers—wire **`url`** or **`client`** per this README.

### From `rate-limiter-flexible`

`rate-limiter-flexible` often uses **points + duration (seconds)**. Convert duration to **`windowMs`** (multiply seconds × 1000) and set **`maxRequests`** ≈ points for a rough sliding-window equivalent.

```ts
// rate-limiter-flexible (conceptual)
// new RateLimiterMemory({ points: 10, duration: 60 })

// ratelimit-flex (sliding window, same order of magnitude)
expressRateLimiter({ maxRequests: 10, windowMs: 60_000 });
```

For **Redis**, replace `RateLimiterRedis` with **`RedisStore`** + **`expressRateLimiter({ store })`**. Use **token bucket** if you relied on burst-style configs.

## Contributing

1. Clone the repo and run **`npm install`**
2. **`npm test`** — Vitest
3. **`npm run lint`** — ESLint
4. **`npm run build`** — TypeScript (`dist/`)

Open a PR with a short description of behavior changes and any new tests.

## License

MIT
