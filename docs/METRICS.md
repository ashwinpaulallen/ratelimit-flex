# Metrics & Observability

Production-grade observability for rate limiting — just flip a switch (`metrics: true`) on **Express** (`expressRateLimiter`) or **Fastify** (`fastifyRateLimiter` from `ratelimit-flex/fastify`).

## Table of Contents

- [Why Metrics Matter](#why-metrics-matter)
- [Quick Start](#quick-start)
- [What's Collected](#whats-collected)
- [Performance Guarantee](#performance-guarantee)
- [Callback & Event-Based Metrics](#callback--event-based-metrics)
- [Prometheus Integration](#prometheus-integration)
- [OpenTelemetry Integration](#opentelemetry-integration)
- [Snapshot API](#snapshot-api)
- [Trends](#trends)
- [Configuration Reference](#configuration-reference)

---

## Why Metrics Matter

Rate limiters are invisible infrastructure: when they work, nobody notices; when they misconfigure or drift, they either let attacks through or frustrate legitimate users. Metrics make the invisible visible — throughput, block rates, latency, and hot keys — so you can tune limits, catch abuse, and prove SLAs.

---

## Quick Start

**Express** — the middleware is also a metrics handle (`getMetricsSnapshot`, `on('metrics', …)`, etc.):

```ts
const limiter = expressRateLimiter({ maxRequests: 100, metrics: true });
app.get('/stats', (req, res) => res.json(limiter.getMetricsSnapshot()));
```

**Fastify** — same `RateLimitOptions.metrics`; the plugin decorates the instance when metrics are enabled:

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
| Prometheus `GET` | `limiter.metricsEndpoint` → `app.use('/metrics', …)` | `app.fastifyMetricsRoute` → `app.get('/metrics', …)` |
| Clean shutdown | `limiter.shutdownMetrics()` | Plugin `onClose` calls `metricsManager.shutdown()` |

---

## What's Collected

Aggregated snapshots expose the following metrics. **Prometheus** uses prefix `ratelimit_` (configurable). **OpenTelemetry** uses `ratelimit_` by default.

| Metric | Type | Description |
|--------|------|-------------|
| `requests_total` | Counter | Total requests by status and reason (allowed, blocked: rate_limit, blocklist, penalty, service_unavailable) |
| `middleware_duration_ms` | Histogram | Time spent in rate limiter middleware per request (ms) |
| `store_duration_ms` | Histogram | Store `increment` latency (e.g. Redis) per operation (ms) |
| `requests_per_second` | Gauge | Estimated throughput over the aggregation window |
| `block_rate` | Gauge | Share of requests blocked (0–1) over the window |
| `hot_key_hits` | Gauge | Top keys by hit count (cardinality capped) |

---

## Performance Guarantee

Metrics collection adds **less than ~2 microseconds per request** on typical hardware. Recording is **synchronous** — numeric increments and fixed ring buffers only: **no allocations** and **no I/O** on the request path. Aggregation runs on a **background timer** (default: every **10 seconds**).

---

## Callback & Event-Based Metrics

### Push — `onMetrics` Callback

Fires each aggregation tick (same option for Express and Fastify):

**Express:**
```ts
expressRateLimiter({
  maxRequests: 100,
  windowMs: 60_000,
  metrics: {
    enabled: true,
    onMetrics: (snapshot) => {
      if (snapshot.window.blockRate > 0.1) {
        console.warn('High block rate', snapshot);
      }
    },
  },
});
```

**Fastify:**
```ts
await app.register(fastifyRateLimiter, {
  maxRequests: 100,
  windowMs: 60_000,
  metrics: {
    enabled: true,
    onMetrics: (snapshot) => {
      if (snapshot.window.blockRate > 0.1) {
        console.warn('High block rate', snapshot);
      }
    },
  },
});
```

### Events — `on('metrics', …)`

Same snapshots as `onMetrics`:

**Express** — on the middleware handler:
```ts
const limiter = expressRateLimiter({ maxRequests: 100, metrics: true });
limiter.on('metrics', (snapshot) => {
  // Handle snapshot
});
```

**Fastify** — on `rateLimitMetrics`:
```ts
await app.register(fastifyRateLimiter, { maxRequests: 100, metrics: true });
app.rateLimitMetrics?.on('metrics', (snapshot) => {
  // Handle snapshot
});
```

### Pull — Latest Snapshot

Returns `null` before the first aggregation tick.

**Express:**
```ts
const snap = limiter.getMetricsSnapshot();
res.json(snap ?? { message: 'No snapshot yet' });
```

**Fastify:**
```ts
const snap = app.getMetricsSnapshot?.() ?? null;
return reply.send(snap ?? { message: 'No snapshot yet' });
```

---

## Prometheus Integration

### Standalone (No prom-client Required)

**Express:**
```ts
const limiter = expressRateLimiter({
  maxRequests: 100,
  metrics: { enabled: true, prometheus: { enabled: true } },
});
if (limiter.metricsEndpoint) {
  app.use('/metrics', limiter.metricsEndpoint);
}
```

**Fastify** — use the native route handler:
```ts
await app.register(fastifyRateLimiter, {
  maxRequests: 100,
  metrics: { enabled: true, prometheus: { enabled: true } },
});
if (app.fastifyMetricsRoute) {
  app.get('/metrics', app.fastifyMetricsRoute);
}
```

### With Existing prom-client Registry

Pass your `Registry`; scrape your global `/metrics` as usual.

**Express:**
```ts
import { Registry } from 'prom-client';

const registry = new Registry();
expressRateLimiter({
  maxRequests: 100,
  metrics: { enabled: true, prometheus: { enabled: true, registry } },
});
```

**Fastify:**
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

### Example PromQL Queries

**Block rate over time:**
```promql
sum(rate(ratelimit_requests_total{status="blocked"}[5m]))
```

**P99 middleware latency:**
```promql
histogram_quantile(
  0.99,
  sum(rate(ratelimit_middleware_duration_milliseconds_bucket[5m])) by (le)
)
```

---

## OpenTelemetry Integration

Pass a **`Meter`** from `@opentelemetry/api` (optional peer dependency). Works with any **OTLP-compatible** backend — **Grafana Cloud**, **Datadog**, **New Relic**, **Honeycomb**, self-hosted collectors, etc.

**Express:**
```ts
import { metrics } from '@opentelemetry/api';
import { expressRateLimiter } from 'ratelimit-flex';

const meter = metrics.getMeter('my-service');
app.use(
  expressRateLimiter({
    maxRequests: 100,
    metrics: { 
      enabled: true, 
      openTelemetry: { enabled: true, meter, prefix: 'ratelimit' } 
    },
  }),
);
```

**Fastify:**
```ts
import { metrics } from '@opentelemetry/api';
import { fastifyRateLimiter } from 'ratelimit-flex/fastify';

const meter = metrics.getMeter('my-service');
await app.register(fastifyRateLimiter, {
  maxRequests: 100,
  metrics: { 
    enabled: true, 
    openTelemetry: { enabled: true, meter, prefix: 'ratelimit' } 
  },
});
```

**Shutdown:**
- **Express:** `limiter.openTelemetryAdapter?.shutdown()`
- **Fastify:** `app.rateLimitMetrics?.getOpenTelemetryAdapter()?.shutdown()` (or let plugin `onClose` handle it)

---

## Snapshot API

### MetricsSnapshot Interface

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
  readonly hotKeys: ReadonlyArray<{
    readonly key: string;
    readonly hits: number;
    readonly blocked: number;
  }>;
  readonly trends: {
    readonly requestRateTrend: 'increasing' | 'decreasing' | 'stable';
    readonly blockRateTrend: 'increasing' | 'decreasing' | 'stable';
    readonly latencyTrend: 'increasing' | 'decreasing' | 'stable';
  };
  readonly latencySamplesMs?: readonly number[];
  readonly storeLatencySamplesMs?: readonly number[];
}
```

### Alerting Examples

**Block rate threshold:**

**Express:**
```ts
limiter.on('metrics', (s) => {
  if (s.window.blockRate > 0.25) {
    void alerting.notify('Block rate above 25%', { 
      blockRate: s.window.blockRate 
    });
  }
});
```

**Fastify:**
```ts
app.rateLimitMetrics?.on('metrics', (s) => {
  if (s.window.blockRate > 0.25) {
    void alerting.notify('Block rate above 25%', { 
      blockRate: s.window.blockRate 
    });
  }
});
```

**Hot keys logging (abuse detection):**

**Express:**
```ts
limiter.on('metrics', (s) => {
  for (const row of s.hotKeys.slice(0, 5)) {
    logger.info({ 
      key: row.key, 
      hits: row.hits, 
      blocked: row.blocked 
    }, 'top rate-limit key');
  }
});
```

**Fastify:**
```ts
app.rateLimitMetrics?.on('metrics', (s) => {
  for (const row of s.hotKeys.slice(0, 5)) {
    logger.info({ 
      key: row.key, 
      hits: row.hits, 
      blocked: row.blocked 
    }, 'top rate-limit key');
  }
});
```

---

## Trends

The collector compares **recent vs earlier** samples in a sliding window (request rate, block rate, mean latency) and labels each series as **`increasing`**, **`decreasing`**, or **`stable`**.

Use **`snapshot.trends.*`** for proactive alerts:
- Rising block rate before user complaints
- Rising latency before timeouts
- Increasing request rate indicating traffic spikes

---

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | — | **Required** when using object form; master switch |
| `intervalMs` | `number` | `10000` | Aggregation / emit interval (ms) |
| `topKSize` | `number` | `20` | How many hot keys to keep in snapshots |
| `histogramBuckets` | `number[]` | (library defaults) | Upper bounds (ms) for latency histograms |
| `onMetrics` | `(snapshot: MetricsSnapshot) => void` | — | Called each tick with the latest snapshot |
| `prometheus` | `{ enabled: boolean; prefix?: string; registry?: unknown }` | — | Prometheus text + optional `prom-client` registry |
| `openTelemetry` | `{ enabled: boolean; meter?: unknown; prefix?: string }` | — | OTel instruments via user-supplied `Meter` |

**Shorthand:** Use `metrics: true` for `{ enabled: true }` with defaults.

**Shutdown:**
- **Express:** Call `limiter.shutdownMetrics()` on process exit
- **Fastify:** Plugin `onClose` handles shutdown automatically; manual call only needed for explicit teardown
