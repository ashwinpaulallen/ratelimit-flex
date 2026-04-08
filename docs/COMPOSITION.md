# Limiter Composition

Combine multiple rate limiters with the `compose` builder. Every composition mode implements `RateLimitStore`, so composed stores plug directly into `expressRateLimiter` / `fastifyRateLimiter` via the `store` option.

## Table of Contents

- [Composition Modes](#composition-modes)
- [Examples](#examples)
  - [Multi-window](#multi-window)
  - [Burst Allowance](#burst-allowance)
  - [Failover Chain](#failover-chain)
  - [Nested Composition](#nested-composition)
- [Per-Layer Observability](#per-layer-observability)
- [Redis Composition Presets](#redis-composition-presets)
- [Migration from limits Array](#migration-from-limits-array)

---

## Composition Modes

| Mode | Behavior | Use case | API |
|------|----------|----------|-----|
| **`all`** | Block if **any** layer blocks; rollback succeeded layers when one blocks | Multi-window limiting (10/sec AND 100/min AND 1000/hour) | `compose.all(...)` |
| **`overflow`** | Try primary first; if blocked, try burst pool (primary counts stay) | Steady rate + burst allowance (5/sec + 20 burst tokens) | `compose.overflow(primary, burst)` or `compose.withBurst({ ... })` |
| **`first-available`** | Try layers in order; first that allows wins (failed attempts rolled back) | Failover chain (Redis → fallback memory) | `compose.firstAvailable(...)` |
| **`race`** | Fire all layers in parallel; fastest response wins | Multi-region latency optimization | `compose.race(...)` |

---

## Examples

### Multi-window

**10/sec AND 100/min — both must allow:**

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

**Redis template** — pass a sliding/fixed-window `RedisStore` as the first argument; each window gets a sibling store with the same connection options and a distinct key prefix (optional `resilience` is cloned per slot with a per-slot insurance `MemoryStore`). Same behavior as `limits: [...]` + `store: redisTemplate` in `mergeRateLimiterOptions`:

```typescript
import { compose, expressRateLimiter, RateLimitStrategy, RedisStore } from 'ratelimit-flex';

const template = new RedisStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
  url: process.env.REDIS_URL!,
  keyPrefix: 'myapp:',
});

const store = compose.windows(
  template,
  { windowMs: 1_000, maxRequests: 10 },
  { windowMs: 60_000, maxRequests: 100 },
);

app.use(expressRateLimiter({ store }));
```

### Burst Allowance

**Steady rate + burst pool:**

```typescript
import { compose, expressRateLimiter } from 'ratelimit-flex';

const store = compose.withBurst({
  steady: { windowMs: 1_000, maxRequests: 5 },
  burst:  { windowMs: 60_000, maxRequests: 20 },
});

app.use(expressRateLimiter({ store }));
```

### Failover Chain

**Try Redis, fall back to memory:**

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

### Nested Composition

**`ComposedStore` can be a layer in another `ComposedStore`:**

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

---

## Per-Layer Observability

Track which layer blocked a request and inspect per-layer results:

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

---

## Redis Composition Presets

### Multi-window with Redis

**10/sec + 100/min + 1000/hour:**

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

### Burst with Redis

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

### Failover Preset

```typescript
import { expressRateLimiter, failoverPreset } from 'ratelimit-flex';

app.use(expressRateLimiter(
  failoverPreset([
    { label: 'primary', store: primaryRedisStore },
    { label: 'fallback', store: fallbackMemoryStore },
  ]),
));
```

---

## Composition Highlights

| Capability | In ratelimit-flex |
|------------|-------------------|
| Multi-window limits (every window must allow) | `compose.all()` — implements `RateLimitStore` for Express/Fastify middleware |
| Steady rate + burst pool | `compose.overflow()` or `compose.withBurst()` |
| Nested compositions | Any `ComposedStore` can be a layer inside another |
| Per-layer visibility | `onLayerBlock`, `req.rateLimitComposed`, `summarize()`, `extractLayerMetrics()` |

---

## Migration from limits Array

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

For **Redis-backed** multi-window slots (shared counters across processes), pass a **`RedisStore`** template with **`limits`** or use **`compose.windows(redisTemplate, …)`** (see README **Multi-window limits**). For **`resilience`**, use **`multiWindowPreset`** or **`groupedWindowStores`**.

---

## Advanced Patterns

### Multi-Region Failover

```typescript
const store = compose.firstAvailable(
  compose.layer('us-east', usEastRedis),
  compose.layer('us-west', usWestRedis),
  compose.layer('memory', memoryFallback),
);
```

### Tiered Rate Limiting

```typescript
// Free tier: 10/min
// Pro tier: 100/min
// Enterprise: 1000/min

const store = compose.all(
  compose.layer('per-second', perSecondStore),
  compose.layer('per-minute', (req) => {
    const tier = req.user?.tier ?? 'free';
    return tierStores[tier]; // Dynamic store selection
  }),
);
```

### Burst Protection with Hourly Cap

```typescript
const store = compose.all(
  compose.overflow(
    compose.layer('steady', steadyStore),    // 5/sec
    compose.layer('burst', burstStore),      // 20 burst tokens
  ),
  compose.layer('hourly-cap', hourlyStore),  // 1000/hour max
);
```

---

## See Also

- [Main README](../README.md#limiter-composition) - Quick overview
- [Request Queuing](./QUEUING.md) - Queue over-limit requests
- [Deployment Guide](../README.md#deployment-guide) - Production patterns
