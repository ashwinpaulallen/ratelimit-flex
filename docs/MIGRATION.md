# Migration Guide

This guide helps you migrate to ratelimit-flex from other rate limiting libraries or upgrade between major versions.

## Table of Contents

- [From express-rate-limit](#from-express-rate-limit)
- [From @fastify/rate-limit](#from-fastifyrate-limit)
- [Upgrading from ratelimit-flex v2.x to v3.x](#upgrading-from-ratelimit-flex-v2x-to-v3x)

---

## From express-rate-limit

Options are the same **`RateLimitOptions`** shape for **`expressRateLimiter`** and **`fastifyRateLimiter`**; only the import path and how you mount the integration differ.

### Option Mapping

| express-rate-limit | ratelimit-flex |
|--------------------|----------------|
| `max` | `maxRequests` |
| `windowMs` | `windowMs` (unchanged) |
| `standardHeaders: true` | `standardHeaders: 'draft-6'` (or use the helper below) |
| `standardHeaders: false` | `standardHeaders: false` |
| `standardHeaders: 'draft-6'` \| `'draft-7'` \| `'draft-8'` | Same string values |
| `legacyHeaders` | `legacyHeaders` |
| `headers: true` (older API) | Prefer `standardHeaders: 'legacy'` or explicit draft profile |

### Using the Helper

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

### Manual Mapping

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

Default export is **`expressRateLimiter`** (same as named import). For **Redis** across instances, use **`RedisStore`**, **`multiInstancePreset`**, or **`resilientRedisPreset`** and wire **`url`** or **`client`** as in the [Deployment guide](../README.md#deployment-guide).

---

## From @fastify/rate-limit

### Option Mapping

| `@fastify/rate-limit` | ratelimit-flex (`ratelimit-flex/fastify`) |
|----------------------|-------------------------------------------|
| `max` | `maxRequests` |
| `timeWindow` (ms number) | `windowMs` (same numeric value) |
| `timeWindow` (`'1 minute'` etc. via [`ms`](https://github.com/vercel/ms)) | `windowMs` — convert to milliseconds (e.g. `60_000` for one minute, or `import ms from 'ms'; ms('1 minute')`) |
| `allowList` | `allowlist` |
| `keyGenerator(request)` | `keyGenerator` — same idea; signature is **`(req: unknown) => string`** (pass your Fastify `request`) |
| `redis` / `nameSpace` | Use **`RedisStore`** with **`url`** / **`client`** and **`keyPrefix`** (see [When to use RedisStore](../README.md#when-to-use-redisstore)) |
| `skip` / `skipOnError` | `skip` — for Redis errors, configure **`onRedisError`** on **`RedisStore`** ([Redis failure handling](../README.md#redis-failure-handling)) |
| `errorResponseBuilder` | `message` / `statusCode` |
| `enableDraftSpec: true` | `standardHeaders: 'draft-6'` (or a newer draft profile) |
| `ban` / `onBanReach` | No single drop-in — use **`penaltyBox`**, **`blocklist`**, or custom handlers as needed |
| Per-route `fastify.rateLimit({ ... })` | Register scoped plugins or use different **`RateLimitOptions`** per route / plugin scope |

### Example Migration

**Before** (@fastify/rate-limit):
```ts
await fastify.register(import('@fastify/rate-limit'), { 
  max: 100, 
  timeWindow: '1 minute' 
});
```

**After** (ratelimit-flex):
```ts
import { fastifyRateLimiter } from 'ratelimit-flex/fastify';

await fastify.register(fastifyRateLimiter, {
  maxRequests: 100,
  windowMs: 60_000,
});
```

### Scoped Registration

**`global: false`** in `@fastify/rate-limit` limits encapsulation to routes registered in that plugin's scope. Achieve the same by registering **`fastifyRateLimiter`** in a [Fastify plugin encapsulation](https://fastify.dev/docs/latest/Reference/Plugins/) context (child instance) instead of the root app.

---

## Upgrading from ratelimit-flex v2.x to v3.x

### Breaking Changes in v3.0.0

#### 1. NestJS: `global` → `globalGuard` Rename

**What changed:**
- The `NestRateLimitModuleOptions.global` option was removed
- Replaced with `globalGuard` which has clearer semantics

**Migration:**

**Before** (v2.x):
```typescript
RateLimitModule.forRoot({
  maxRequests: 100,
  windowMs: 60_000,
  global: true, // Old option
})
```

**After** (v3.x):
```typescript
RateLimitModule.forRoot({
  maxRequests: 100,
  windowMs: 60_000,
  globalGuard: true, // New option
})
```

**Behavior:**
- `globalGuard: true` (default): Registers `APP_GUARD` and makes the module global
- `globalGuard: false`: Does NOT register `APP_GUARD` AND sets `DynamicModule.global` to `false`

#### 2. NestJS: Module Scope Changes

**What changed:**
When `globalGuard: false`, the module is no longer a global module. Feature modules that need the injection tokens must explicitly import `RateLimitModule`.

**Before** (v2.x with `global: false`):
```typescript
// In v2.x, you could set global: false to disable APP_GUARD
// while keeping the module global for tokens app-wide
RateLimitModule.forRoot({
  maxRequests: 100,
  windowMs: 60_000,
  global: false, // Only disabled APP_GUARD
})

// Tokens were still available everywhere
@Injectable()
export class SomeService {
  constructor(@Inject(RATE_LIMIT_STORE) private store: RateLimitStore) {}
}
```

**After** (v3.x):
```typescript
// In v3.x, globalGuard: false means BOTH:
// 1. No APP_GUARD registration
// 2. Module is not global (tokens not available everywhere)

// Option A: Keep globalGuard: true and use @SkipRateLimit() where needed
RateLimitModule.forRoot({
  maxRequests: 100,
  windowMs: 60_000,
  globalGuard: true, // Default
})

@SkipRateLimit()
@Controller('health')
export class HealthController {
  // This controller skips rate limiting
}

// Option B: Use globalGuard: false and manually register the guard
RateLimitModule.forRoot({
  maxRequests: 100,
  windowMs: 60_000,
  globalGuard: false,
})

// Then manually apply the guard where needed
@UseGuards(RateLimitGuard)
@Controller('api')
export class ApiController {
  // Only this controller is rate limited
}

// And import RateLimitModule in feature modules that need tokens
@Module({
  imports: [RateLimitModule],
  providers: [SomeService],
})
export class FeatureModule {}
```

### Migration Checklist

- [ ] Replace all instances of `global` with `globalGuard` in `RateLimitModule.forRoot()` and `forRootAsync()`
- [ ] If you used `global: false` to disable `APP_GUARD` while keeping tokens available:
  - [ ] Switch to `globalGuard: true` (default) and use `@SkipRateLimit()` decorator
  - [ ] OR keep `globalGuard: false` and import `RateLimitModule` in feature modules that need tokens
- [ ] Test that rate limiting still works as expected
- [ ] Test that injection tokens (`RATE_LIMIT_STORE`, `RATE_LIMIT_KEY_MANAGER`, etc.) are available where needed

### Other Changes in v3.0.0

See [CHANGELOG.md](../CHANGELOG.md) for a complete list of changes, including:
- New features added in v3.0.0
- Performance improvements
- Bug fixes
- Deprecation notices

---

## Need Help?

If you encounter issues during migration:

1. Check the [README](../README.md) for current API documentation
2. Review the [CHANGELOG](../CHANGELOG.md) for detailed version history
3. Look at [examples/](../examples/) for working code samples
4. Open an issue on GitHub with your migration question
