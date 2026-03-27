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

## API Reference

### Exports

```ts
import rateLimit, {
  expressRateLimiter,
  fastifyRateLimiter,
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

- Default export: `expressRateLimiter`
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
| `maxRequests` | `number` | `100` | Max requests per window for sliding/fixed window |
| `tokensPerInterval` | `number` | `10` | Tokens refilled per interval (token bucket) |
| `interval` | `number` | `60000` | Refill interval in ms (token bucket) |
| `bucketSize` | `number` | `100` | Max bucket capacity (token bucket burst size) |

### Defaults

- `slidingWindowDefaults`: `{ strategy: SLIDING_WINDOW, windowMs: 60000, maxRequests: 100 }`
- `fixedWindowDefaults`: `{ strategy: FIXED_WINDOW, windowMs: 60000, maxRequests: 100 }`
- `tokenBucketDefaults`: `{ strategy: TOKEN_BUCKET, tokensPerInterval: 10, interval: 60000, bucketSize: 100 }`

### Convenience Factory: `createRateLimiter(options)`

`createRateLimiter` returns an object with both `.express` and `.fastify` properties:

```ts
const limiter = createRateLimiter({ maxRequests: 100 });
app.use(limiter.express);           // Express
await app.register(limiter.fastify); // Fastify
```

**Note**: This function requires `fastify-plugin` as a peer dependency (already listed). For best type-safety and clarity, prefer direct imports (`expressRateLimiter` or `fastifyRateLimiter`) when you already know your framework.

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
import { fastifyRateLimiter, RateLimitStrategy } from 'ratelimit-flex';

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

## Stores

| Store | Best for | Pros | Trade-offs |
|---|---|---|---|
| `MemoryStore` | Single-instance apps, local development | Zero setup, fastest, no external dependencies | Not shared across multiple app instances/processes |
| `RedisStore` | Multi-instance/distributed deployments | Shared counters across nodes, atomic operations via Lua scripts | Requires Redis and network round-trips |

## Writing Custom Stores

Implement the `RateLimitStore` interface:

```ts
export interface RateLimitStore {
  increment(key: string): Promise<{
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