# ratelimit-flex

[![npm version](https://img.shields.io/npm/v/ratelimit-flex.svg)](https://www.npmjs.com/package/ratelimit-flex)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
![Tests](https://img.shields.io/badge/tests-vitest%20passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-First-3178C6?logo=typescript&logoColor=white)

Flexible, TypeScript-first rate limiting for Node.js APIs with first-class Express and Fastify support.

**Key features**
- Multiple strategies: sliding window, token bucket, fixed window
- Works with Express and Fastify
- Pluggable stores: in-memory and Redis
- Strong TypeScript types and clean public API
- Supports custom keys, skip logic, callbacks, and custom responses
- **Advanced (v1.1+)**: multiple windows per route, dynamic per-request limits, penalty box, allow/block lists, and draft mode for safe production tuning

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

**Note:** The published package targets **Node.js 18+**. Continuous integration and local development use **Node.js 20.12+** because Vitest 4 depends on APIs that are not available on Node 18.

## Quick Start (Express)

```ts
import express from 'express';
import rateLimit from 'ratelimit-flex';
const app = express();
app.use(rateLimit({ maxRequests: 100, windowMs: 60_000 }));
app.get('/health', (_req, res) => res.json({ ok: true }));
```

## Strategies

### Sliding Window
Most accurate for per-window fairness because each request is counted against a moving window, not a fixed boundary. Use this as your default for user-facing APIs where consistency matters more than minimal memory usage.

### Token Bucket
Great when you want to allow short bursts while still enforcing a long-term average rate. Useful for APIs where occasional spikes are expected (mobile reconnects, batchy clients, webhook retries).

### Fixed Window
Simplest and most memory-efficient approach. Best for straightforward rate limiting where slight boundary effects are acceptable (for example, internal tools or low-risk endpoints).

## Advanced features (1.1+)

These options work with `expressRateLimiter`, `fastifyRateLimiter`, and `RateLimitEngine` / `createRateLimiter` (where applicable).

### Multiple windows on one route (`limits`)

Use `limits` instead of a single `windowMs` / `maxRequests`. Each entry is `{ windowMs, max }`. The same client key is checked against **every** window; the request is blocked if **any** window is exceeded. The middleware creates one in-memory store per window.

```ts
app.use(
  expressRateLimiter({
    limits: [
      { windowMs: 60_000, max: 100 }, // per minute
      { windowMs: 3_600_000, max: 1000 }, // per hour
    ],
  }),
);
```

### Dynamic `maxRequests`

For sliding or fixed window, `maxRequests` may be a function that returns the cap for the current request (for example based on auth or headers):

```ts
app.use(
  expressRateLimiter({
    windowMs: 60_000,
    maxRequests: (req) =>
      (req as import('express').Request).user?.isPremium ? 1000 : 100,
  }),
);
```

### Penalty box

After repeated **real** rate-limit blocks (not draft), the client can be temporarily banned. Violation timestamps are tracked in a sliding `violationWindowMs` (default one hour). When the count reaches `violationsThreshold`, the client is blocked for `penaltyDurationMs`. This state lives on the `RateLimitEngine` instance (not in the store), so it does not automatically sync across multiple app processes.

```ts
app.use(
  expressRateLimiter({
    maxRequests: 10,
    windowMs: 60_000,
    penaltyBox: {
      violationsThreshold: 5,
      violationWindowMs: 3_600_000,
      penaltyDurationMs: 900_000, // 15 minutes
      onPenalty: async (req) => {
        /* e.g. audit log */
      },
    },
  }),
);
```

### Allowlist and blocklist

Both lists match the **same string** produced by `keyGenerator` (often IP or API key). Allowlisted keys skip rate limiting entirely. Blocklisted keys are rejected before consuming quota, with `blocklistStatusCode` (default `403`) and `blocklistMessage` (default `"Forbidden"`).

```ts
app.use(
  expressRateLimiter({
    allowlist: ['203.0.113.10'],
    blocklist: ['bad-api-key'],
    keyGenerator: (req) =>
      String((req as import('express').Request).header('x-api-key') ?? 'anonymous'),
  }),
);
```

### Draft mode

Set `draft: true` to observe what **would** have been blocked without actually returning 429. Each would-be hit is rolled back so counters stay unchanged. Use `onDraftViolation` to log or metrics. On the engine, check `draftWouldBlock` on the consume result.

```ts
app.use(
  expressRateLimiter({
    draft: true,
    onDraftViolation: (req, result) => {
      console.warn('Would block', { result });
    },
    maxRequests: 100,
    windowMs: 60_000,
  }),
);
```

## API Reference

### Exports

```ts
import rateLimit, {
  expressRateLimiter,
  createRateLimiter,
  createRateLimitEngine,
  MemoryStore,
  RedisStore,
  RateLimitEngine,
  RateLimitStrategy,
  slidingWindowDefaults,
  fixedWindowDefaults,
  tokenBucketDefaults,
} from 'ratelimit-flex';
```

```ts
import { fastifyRateLimiter } from 'ratelimit-flex/fastify';
```

- Default export: `expressRateLimiter`
- Fastify plugin: import from `ratelimit-flex/fastify` (keeps `fastify` / `fastify-plugin` off the main entry for Express-only apps)
- Named exports include all of the above plus all types from `types/index.ts`
- `createRateLimitEngine(options)`: factory that returns a `RateLimitEngine` instance (for advanced use cases)

### `RateLimitOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `strategy` | `RateLimitStrategy` | `SLIDING_WINDOW` | Strategy to use: `SLIDING_WINDOW`, `TOKEN_BUCKET`, or `FIXED_WINDOW` |
| `store` | `RateLimitStore` | `MemoryStore` (when omitted in middleware helpers) | Backing store for counters/token state |
| `keyGenerator` | `(req: unknown) => string` | framework IP-based fallback | Builds the rate-limit key (user, API key, tenant, etc.) |
| `onLimitReached` | `(req, result) => void \| Promise<void>` | `undefined` | Called when a request is blocked |
| `skip` | `(req: unknown) => boolean` | `undefined` | Skip rate limiting entirely for matching requests |
| `headers` | `boolean` | `true` | Adds `X-RateLimit-*` and `Retry-After` headers |
| `statusCode` | `number` | `429` | HTTP status code used when blocked |
| `message` | `string \| object` | `"Too many requests"` | Error payload wrapped as `{ error: message }` |
| `skipFailedRequests` | `boolean` | `false` | Decrement usage for failed responses (`>= 400`) |
| `skipSuccessfulRequests` | `boolean` | `false` | Decrement usage for successful responses (`< 400`) |
| `windowMs` | `number` | `60000` | Window length for sliding/fixed window strategies |
| `limits` | `{ windowMs, max }[]` | `undefined` | Multiple independent windows; blocks if **any** limit is exceeded (ignores single `windowMs` / `maxRequests` for the default store setup) |
| `maxRequests` | `number \| (req) => number` | `100` | Max requests per window for sliding/fixed window, or a per-request cap |
| `allowlist` | `string[]` | `undefined` | Keys that skip rate limiting |
| `blocklist` | `string[]` | `undefined` | Keys always rejected before counting |
| `blocklistStatusCode` | `number` | `403` | Status for blocklist hits |
| `blocklistMessage` | `string \| object` | `"Forbidden"` | Body for blocklist hits (`{ error: message }`) |
| `penaltyBox` | `PenaltyBoxOptions` | `undefined` | Temporary ban after repeated limit violations (engine-local state) |
| `draft` | `boolean` | `false` | Would-be blocks are logged/observed only; increments rolled back |
| `onDraftViolation` | `(req, result) => void \| Promise<void>` | `undefined` | Called in draft mode when a request would have been blocked |
| `tokensPerInterval` | `number` | `10` | Tokens refilled per interval (token bucket) |
| `interval` | `number` | `60000` | Refill interval in ms (token bucket) |
| `bucketSize` | `number` | `100` | Max bucket capacity (token bucket burst size) |

### Defaults

- `slidingWindowDefaults`: `{ strategy: SLIDING_WINDOW, windowMs: 60000, maxRequests: 100 }`
- `fixedWindowDefaults`: `{ strategy: FIXED_WINDOW, windowMs: 60000, maxRequests: 100 }`
- `tokenBucketDefaults`: `{ strategy: TOKEN_BUCKET, tokensPerInterval: 10, interval: 60000, bucketSize: 100 }`

### Convenience Factory: `createRateLimiter(options)`

`createRateLimiter` returns `{ express }` — Express middleware only. For Fastify, use `import { fastifyRateLimiter } from 'ratelimit-flex/fastify'`.

```ts
const limiter = createRateLimiter({ maxRequests: 100 });
app.use(limiter.express);
```

## Examples

### Basic Express usage

```ts
import express from 'express';
import { expressRateLimiter } from 'ratelimit-flex';

const app = express();
app.use(
  expressRateLimiter({
    strategy: 'SLIDING_WINDOW',
    windowMs: 60_000,
    maxRequests: 100,
  }),
);
```

### Basic Fastify usage

```ts
import Fastify from 'fastify';
import { fastifyRateLimiter } from 'ratelimit-flex/fastify';
import { RateLimitStrategy } from 'ratelimit-flex';

const app = Fastify();
await app.register(fastifyRateLimiter, {
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
});
```

### Per-user rate limiting by API key

```ts
import { expressRateLimiter } from 'ratelimit-flex';

app.use(
  expressRateLimiter({
    maxRequests: 60,
    windowMs: 60_000,
    keyGenerator: (req) =>
      String((req as import('express').Request).header('x-api-key') ?? 'anonymous'),
  }),
);
```

### Token bucket for API endpoints

```ts
import { expressRateLimiter, RateLimitStrategy } from 'ratelimit-flex';

app.use(
  '/api',
  expressRateLimiter({
    strategy: RateLimitStrategy.TOKEN_BUCKET,
    tokensPerInterval: 20,
    interval: 60_000,
    bucketSize: 60,
  }),
);
```

### Using RedisStore for distributed systems

```ts
import { expressRateLimiter, RedisStore, RateLimitStrategy } from 'ratelimit-flex';

const store = new RedisStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
  url: process.env.REDIS_URL!,
});

app.use(expressRateLimiter({ strategy: RateLimitStrategy.SLIDING_WINDOW, store }));
```

### Custom error responses

```ts
app.use(
  expressRateLimiter({
    maxRequests: 20,
    windowMs: 60_000,
    statusCode: 429,
    message: { code: 'RATE_LIMITED', detail: 'Please retry shortly.' },
  }),
);
```

### Skipping certain routes

```ts
app.use(
  expressRateLimiter({
    maxRequests: 100,
    windowMs: 60_000,
    skip: (req) => String((req as { path?: string }).path ?? '').startsWith('/health'),
  }),
);
```

### Multiple rate limiters (global + per-endpoint)

```ts
import { expressRateLimiter } from 'ratelimit-flex';

app.use(expressRateLimiter({ maxRequests: 100, windowMs: 60_000 })); // global
app.use('/login', expressRateLimiter({ maxRequests: 10, windowMs: 60_000 })); // strict endpoint
```

### Engine: `blockReason` and draft

When using `RateLimitEngine` or `createRateLimiter` directly, consume results can include:

- `blockReason`: `'rate_limit' | 'blocklist' | 'penalty'`
- `draftWouldBlock`: `true` when `draft` is enabled and the request would have exceeded the limit

## Stores

| Store | Best for | Pros | Trade-offs |
|---|---|---|---|
| `MemoryStore` | Single-instance apps, local development | Zero setup, fastest, no external dependencies | Not shared across multiple app instances/processes |
| `RedisStore` | Multi-instance/distributed deployments | Shared counters across nodes, atomic operations via Lua scripts | Requires Redis and network round-trips |

## Writing Custom Stores

Implement the `RateLimitStore` interface:

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
  }>;
  decrement(key: string): Promise<void>;
  reset(key: string): Promise<void>;
  shutdown(): Promise<void>;
}
```

Window strategies may use `options.maxRequests` to override the store’s configured cap for that increment (used for dynamic `maxRequests` functions).

Use your custom store by passing `store` in options:

```ts
app.use(expressRateLimiter({ store: myCustomStore, maxRequests: 100, windowMs: 60_000 }));
```

## Contributing

Contributions are welcome.

1. Fork the repository
2. Create a feature branch
3. Add or update tests
4. Run checks locally:
   - `npm test`
   - `npm run build`
   - `npm run lint`
5. Open a pull request with context and rationale

## License

MIT