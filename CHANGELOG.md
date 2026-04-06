# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- **Hono:** **`skipFailedRequests`** / **`skipSuccessfulRequests`** use **`resolvedHonoRollbackStatus`** so missing **`c.res`**, **`c.res.status`** **0**, non-finite values, or codes outside **100–599** do not mis-trigger rollbacks (defaults to **200**). **`resolvedHonoRollbackStatus`** is exported from **`ratelimit-flex/hono`** for custom middleware.

## [3.0.0] - 2026-04-06

### Breaking changes

- **NestJS:** Removed **`NestRateLimitModuleOptions.global`** and **`global`** on **`RateLimitModule.forRootAsync`**. Use **`globalGuard`** only (same boolean semantics). Passing an object that **still has own property `global`** throws a clear error at module registration time.

### Added

- **`KeyedRateLimiterQueue`** — LRU-bounded pool of **`RateLimiterQueue`** instances for many independent keys (see README **Request queuing**).

- **Hono:** **`skipFailedRequests`** and **`skipSuccessfulRequests`** on **`rateLimiter()`** — after **`await next()`**, decrements when **`c.res.status`** matches Express semantics. **`pretest`** runs **`sync-version`** so **`VERSION`** matches **`package.json`** before **`vitest`**.

### Documentation (historical / rolled up)

- **Discoverability:** `docs/recipes.md`, **`npm run docs:api`**, security, Redis examples, queuing notes, **`penaltyBox` vs Key Manager**, In-memory shield warnings — many items landed across **2.4.x**; see **2.4.0** below for the Nest/Hono integration entry points.

### Tests & fixes (rolled up from planned 2.4.1)

- **Tests:** Composed-store **minified `constructor.name`** + **`resolveIncrementOpts`**; Nest **`RateLimitGuard`** route-engine fingerprint regression; **`clamp`** property-style tests.

- **Cluster IPC:** **`protocolVersion`** handshake (**`init`** / **`init_ack`** / **`init_nack`**).

- **In-memory shield:** Non-production **double-wrap** warning when **`inMemoryBlock`** stacks on an existing **`InMemoryShield`**.

### Breaking changes (NestJS) — from 2.4.x line

- **`RateLimitDecoratorOptions`:** **`strategy` was removed.** Per-route strategy was never applied correctly (shared engine). Migrate: set `strategy` on `RateLimitModule.forRoot` / `forRootAsync`, use another `RateLimitModule`, or remove `strategy` from `@RateLimit(...)`. Legacy metadata with a conflicting `strategy` **throws** when `NODE_ENV !== 'production'`; in production the key is ignored.

### Fixed

- **NestJS:** `RateLimitGuard` re-merge of module options no longer trips the `penaltyBox` + `keyManager` mutual-exclusion check when both come from `forRoot` with `penaltyBox` (auto KeyManager). **`mergeRateLimiterOptions`** accepts optional **`allowPenaltyBoxWithKeyManager`**.

- **NestJS:** Per-route **`RateLimitEngine`** cache is keyed by handler **and** an options **fingerprint** (`fingerprintRouteEngineOptions`), so a changed merged config for the same handler no longer reuses a stale engine.

- **NestJS:** Conflicting per-route `strategy` metadata is **rejected** in development/test instead of silently warned.

- **Composition:** `resolveIncrementOpts` no longer relies on `constructor.name === 'ComposedStore'` (unsafe with minifiers). Detection uses **`COMPOSED_STORE_BRAND`**, **`registerComposedStoreFacade`** / **`unregisterComposedStoreFacade`** (WeakMap, for opaque `Proxy` facades), optional **`COMPOSED_UNWRAP`** (e.g. `InMemoryShield` → inner), and a prototype-chain check (subclasses / forwarding proxies). **`isComposedStoreBrand()`** implements this; **`COMPOSED_UNWRAP`** is exported for custom wrappers.


## [2.4.0] - 2026-04-06

### Added

- NestJS integration (`ratelimit-flex/nestjs`): `RateLimitModule`, `RateLimitGuard`,
  `@RateLimit()` and `@SkipRateLimit()` decorators, `forRoot` / `forRootAsync`,
  DI injection tokens, GraphQL/WebSocket/RPC context support, NestJS presets
- Hono integration (`ratelimit-flex/hono`): `rateLimiter()`, `queuedRateLimiter()`,
  `webSocketLimiter()` middleware factories, typed Hono Context, edge/serverless compatible
  - `HonoRateLimiterHandler` with metrics support (`metricsManager`, `getMetricsSnapshot()`, `getMetricsHistory()`, `shutdown()`)
  - `honoDefaultKeyGenerator` exported for custom key generator composition
  - `inMemoryBlock` support in both `rateLimiter` and `queuedRateLimiter` for DoS protection
  - Error handling wrapper for graceful failure recovery
  - **Note:** `skipFailedRequests`/`skipSuccessfulRequests` were added on **`rateLimiter()`** in **3.0.0** (after **`await next()`**, using **`c.res.status`**).

### Changed

- **NestJS:** `globalGuard` (preferred) and deprecated `global` now control both `APP_GUARD` registration **and** Nest `DynamicModule.global`. Previously `global: false` skipped the guard but the module was still registered as global, which was easy to misread.

### Breaking changes

- **NestJS (`RateLimitModule.forRoot` / `forRootAsync`):** If you previously passed **`globalGuard: false`** only to **disable automatic `APP_GUARD` registration** while still relying on the module being a **Nest global module** (so `RATE_LIMIT_*` tokens were available everywhere without importing `RateLimitModule` again), behavior has changed: **`false` now also sets `DynamicModule.global` to `false`**, so those tokens are no longer re-exported app-wide unless you import `RateLimitModule` where needed (or register the guard manually with `@UseGuards(RateLimitGuard)` and import the module for DI). The deprecated **`global`** option was removed in **3.0.0** — use **`globalGuard`** only.

## [2.3.0] - 2026-04-07

### Added

- `InMemoryShield` — store wrapper that caches blocked keys in memory, eliminating store round-trips under DoS conditions (7x+ speedup, 99%+ fewer store calls)
- `shield()` helper for easy wrapping
- `inMemoryBlock` middleware option: `true`, a number, or full `InMemoryShieldOptions`
- Shield metrics: `getMetrics()`, integrated into Prometheus/OTel adapters
- Shield inspection: `isShielded()`, `getShieldedKeys()`, `unshield()`, `clearShield()`
- LRU eviction for bounded memory under distributed attacks (`maxBlockedKeys`)
- Lazy + proactive expiry (no per-key setTimeout, no Event Loop overload)
- KeyManager integration: reward/unblock/delete auto-invalidate the shield cache
- Presets `multiInstancePreset`, `resilientRedisPreset`, `apiGatewayPreset`, `authEndpointPreset` now enable shielding by default

## [2.2.0] - 2026-04-06

### Added

- **`KeyManager` class** — programmatic `block` / `penalty` / `reward` / `get` / `set` / `delete` for rate limit keys
- **`get()` and `set()` methods on `RateLimitStore`** (optional, implemented on `MemoryStore` and `RedisStore`)
- **`delete()` method on `RateLimitStore`** (returns `boolean`, distinct from `reset`)
- **Typed `BlockReason`** — `manual`, `penalty-escalation`, `abuse-pattern`, `custom`
- **Event system** — `blocked`, `unblocked`, `penalized`, `rewarded`, `deleted`, `set`
- **Audit log** with filtering (by key, action, time range)
- **Escalation strategies** — `fixedEscalation`, `linearEscalation`, `exponentialEscalation`, `fibonacciEscalation`, `capped`
- **`BlockStore` interface** with **`RedisBlockStore`** for cross-process block persistence
- **Admin REST endpoints** — `createAdminRouter()` (Express) and **`fastifyAdminPlugin`** (Fastify)
- **Existing `penaltyBox` option** is now powered by `KeyManager` internally (backward compatible)

### Changed

- **`RateLimitStore` interface** extended with optional `get()`, `set()`, `delete()` methods (non-breaking)

## [2.1.0] - 2026-04-05

### Added

- **Limiter composition system**: `compose.all()`, `compose.overflow()`, `compose.firstAvailable()`, `compose.race()` — combine multiple rate limiters with different strategies
- **`ComposedStore`** — implements `RateLimitStore` for direct middleware integration, supports full nesting
- **Fluent builder API**: `compose.layer()`, `compose.windows()`, `compose.withBurst()` for ergonomic composition
- **Per-layer observability**: `ComposedIncrementResult.layers` with per-layer status, `decidingPath` for nested compositions, `summarize()` for human-readable output, `extractLayerMetrics()` for metrics extraction
- **`onLayerBlock` callback** — middleware option for per-layer block notifications with full layer result details
- **Redis composition presets**: `multiWindowPreset` (multi-window with Redis), `burstablePreset` (burst with Redis), `failoverPreset` (failover chain)
- **Nested composition support** — `ComposedStore` can be a layer in another `ComposedStore` (e.g., overflow inside all with hourly cap)
- **Comprehensive tests**: 481 tests covering composition modes, nested compositions, equivalence with `limits` array, integration tests with Express/Fastify
- **README Limiter composition section** — detailed documentation with composition modes table, examples (multi-window, burst, failover, nested), per-layer observability, Redis presets, and migration guide from `limits` array

### Changed

- **`limits` array** is now powered by the composition system internally (`compose.windows()`) — fully backward compatible, existing code works unchanged
- **Internal refactoring** — eliminated code duplication in `ComposedStore` summary formatting and `getLimit()` resolution

### Fixed

- **Type inference** — all `compose` methods now provide full TypeScript type inference and autocomplete

## [2.0.0] - TBD

### Added

- Main package (`ratelimit-flex`) exports **`expressQueuedRateLimiter`** (Express middleware that queues over-limit traffic), alongside **`createRateLimiterQueue`**, **`RateLimiterQueue`**, **`RateLimiterQueueError`**, and types **`RateLimiterQueueOptions`** and **`RateLimiterQueueResult`**.
- README **Request queuing** section with outbound API (`createRateLimiterQueue`) and Express middleware examples.
- **`queuedClusterPreset()`** — combines **`ClusterStore`** (shared counters via cluster IPC) with options for **`expressQueuedRateLimiter`** / **`fastifyQueuedRateLimiter`** (queue instead of immediate 429).
- **`createStore({ type: 'cluster', ... })`** — factory support for **`ClusterStore`** (worker-only; requires `keyPrefix` and strategy config).
- **ClusterStore** — Node.js native `cluster` IPC-based rate limiting without Redis. Workers send increment/decrement/reset operations to the primary process via typed IPC messages; the primary maintains a shared `MemoryStore` per `keyPrefix`.
- **ClusterStorePrimary** — singleton on the primary process that listens for worker IPC and manages shared `MemoryStore` instances.
- **`clusterPreset()`** — preset for `ClusterStore` with sensible defaults (sliding window, 100 req/min).
- **`isPm2ManagedProcess()`** — heuristic helper exported from `ratelimit-flex` to detect PM2 (`PM2_HOME` or `pm_id` env vars).
- Public exports for **`ClusterStore`**, **`ClusterStoreOptions`**, cluster IPC protocol types (**`ClusterWorkerMessage`**, **`ClusterPrimaryMessage`**, **`ClusterStoreInitOptions`**, **`isRateLimitFlexMessage`**).
- Subpath import **`ratelimit-flex/cluster`** re-exports the IPC protocol and **`ClusterStorePrimary`** (see `src/cluster/index.ts`).
- **PM2 detection** — `ClusterStore` constructor throws a clear error when PM2 env vars are detected, explaining that PM2 uses its own IPC (not Node's `cluster` protocol) and suggesting `RedisStore` instead.
- **Graceful shutdown documentation** — JSDoc example for `expressQueuedRateLimiter` showing how to call `handler.queue.shutdown()` on `SIGTERM`.
- **Store ownership documentation** — `RateLimiterQueue` constructor, `shutdown()`, `clear()`, and `QueuedRateLimiterOptions.store` now document that `shutdown()` closes the backing store. If sharing a store across multiple queues or components, use `clear()` instead of `shutdown()` to avoid closing the shared store prematurely. Added test coverage for shared store scenarios.
- **Head-of-line blocking documentation** — `RateLimiterQueue`, `RateLimiterQueueOptions`, `createRateLimiterQueue`, `expressQueuedRateLimiter`, and `fastifyQueuedRateLimiter` now document that the queue is a single FIFO array. When a request for key "A" is blocked, subsequent requests for key "B" also wait, even if "B" has capacity. This is intentional for the outbound API throttler use case (typically one key per queue), but users should create one queue per key for independent processing. Added comprehensive examples and test coverage demonstrating the behavior and solutions.
- **Runtime validation** — `createStore` with `type: 'cluster'` and `TOKEN_BUCKET` now validates required fields (`tokensPerInterval`, `interval`, `bucketSize`) at runtime for JavaScript consumers.
- **CI-aware integration tests** — queue timing assertions use more lenient thresholds when `process.env.CI` is set to prevent flakiness on slow CI machines.

### Changed

- **`RateLimiterQueueError` now includes `code` field** — Error instances have a typed `code` property (`'queue_full'` | `'queue_timeout'` | `'queue_shutdown'` | `'queue_cleared'` | `'cost_exceeds_limit'`) for robust error handling. The `retryAfterSeconds` helper in Express/Fastify queued middleware now checks `err.code === 'queue_timeout'` instead of fragile string matching on `err.message`.
- **Refactored shared middleware utilities** — `resolveCost` and `retryAfterSeconds` are now exported from `src/queue/queue-middleware-utils.ts` to eliminate code duplication between Express and Fastify adapters.

### Fixed

- **`RateLimiterQueue` TOKEN_BUCKET stale-head bug** — `undoIncrementAfterFailedOrStaleHead` now checks `isBlocked` status instead of only `kind`. Previously, when a TOKEN_BUCKET increment returned `isBlocked: true` and the queue entry timed out (stale-head), the undo path would incorrectly call `decrement`, inflating the bucket by adding tokens that were never consumed. The fix passes `result.isBlocked` to the undo method and guards both `'blocked'` and `'stale-head'` cases when `isBlocked && TOKEN_BUCKET`.
- **Fragile error message matching in `retryAfterSeconds`** — Express and Fastify queued middleware now use `err.code` instead of `err.message.includes('timeout')` to determine `Retry-After` header value, preventing silent breakage if error messages change.
- **`RateLimiterQueue` timeout-removes-head drain delay** — When a queued entry times out while `drain()` is sleeping on `drainTimer`, the timeout handler now clears the drain timer and resets the `processing` flag if the timed-out entry was the head of the queue. This allows the next entry to be processed immediately when the window resets, instead of waiting for the full remaining `drainTimer` duration (which could be up to `windowMs` for long windows). Added test coverage demonstrating the performance improvement.
- **`ClusterStorePrimary`**: process worker IPC messages **serially** on the primary so concurrent increments cannot race the in-memory store (unbounded queue, but local IPC + in-memory stores are fast).
- **`ClusterStorePrimary`**: `init` for an existing `keyPrefix` is **idempotent** (additional workers attach to the same `MemoryStore` instead of replacing it and resetting counters).
- **`ClusterStorePrimary`**: `tearDown` no longer resets the dispatch queue while IPC handlers may still be running (avoids "Store not initialized" races during shutdown).
- **`process.send()` binding** — `ClusterStore` calls `process.send(msg)` directly instead of extracting to a variable (which breaks the internal `this` binding and causes `ERR_IPC_CHANNEL_CLOSED`).

## [1.4.0] - 2026-04-03

### Added

- Standard IETF RateLimit headers: **`standardHeaders`** option supporting **`'draft-6'`**, **`'draft-7'`**, and **`'draft-8'`** formats
- **`identifier`** option for naming quota policies in draft-7/8 headers
- **`legacyHeaders`** option to control **`X-RateLimit-*`** header output independently
- **`formatRateLimitHeaders()`** exported for custom middleware authors
- **`fromExpressRateLimitOptions()`** migration helper
- Presets now default to standard header formats

### Changed

- Existing **`headers: true`** behavior is completely unchanged (backward compatible)

## [1.3.2] - 2026-04-02

### Added

- **Insurance limiter** — automatic `MemoryStore` fallback when Redis is unreachable.
- **Circuit breaker** — three-state (closed / open / half-open) circuit breaker avoids wasted Redis round-trips during outage.
- **Counter sync** — in-memory counters replay to Redis on recovery (configurable via `syncOnRecovery`).
- **Resilience hooks** — `onFailover`, `onRecovery`, `onCircuitOpen`, `onCircuitClose`, `onInsuranceHit`, `onCounterSync`.
- **`resilientRedisPreset()`** — one-line setup for production Redis with insurance, circuit breaker, and auto-scaled per-worker limits.
- **`X-RateLimit-Store: fallback`** response header when serving from insurance store.
- **`MemoryStore.getActiveKeys()`** and **`MemoryStore.resetAll()`** public methods.
- **Startup warning** when `RedisStore` is used without insurance in multi-instance environments.

### Changed

- **`RedisStore`** constructor now accepts optional **`resilience`** field (non-breaking, fully backward compatible).

## [1.3.1] - 2026-04-01

### Added

- **Weighted / cost-based rate limiting** — `rateLimitOptions.incrementCost` (`number` or `(req) => number`) so a single request can consume more than one quota unit (for example large uploads or expensive GraphQL operations). Applies to **`MemoryStore`** and **`RedisStore`** for sliding window, fixed window, and token bucket.
- **`RateLimitIncrementOptions.cost`** — optional per-call weight on `store.increment(key, { cost })` (default `1`, sanitized to an integer ≥ 1).
- **`RateLimitDecrementOptions`** — optional `cost` on `store.decrement(key, { cost })` so rollbacks match weighted increments (used by draft mode, grouped-window rollback, and `skipFailedRequests` / `skipSuccessfulRequests` middleware).
- **`resolveIncrementOpts(options, req)`** and **`matchingDecrementOptions(incOpts)`** — exported helpers for custom middleware or custom stores.

### Fixed

- **Redis sliding window (`RedisStore`)** — ZSET members for multi-`cost` increments are now unique per slot using **cryptographically random** hex strings passed from Node into the Lua script, avoiding collisions where `ZADD` would overwrite an existing member instead of adding another hit.

## [1.3.0] - 2026-03-31

### Added

- **Metrics & observability** — `MetricsCounters`, `MetricsCollector`, `MetricsManager`, `MetricsSnapshot`, `Histogram`, Prometheus / OpenTelemetry / callback adapters, Express and Fastify wiring (`getMetricsSnapshot`, `getMetricsHistory`, `metricsEndpoint`, `on('metrics')`).
- **Fastify** — when metrics are enabled, `getMetricsSnapshot`, `getMetricsHistory`, and `metricsEndpoint` are decorated on the instance (alongside `rateLimitMetrics`) for parity with Express handler ergonomics.

### Changed

- **`MetricsConfig` validation** — `intervalMs` must be at least **1000** (warning logged if under **5000**); `topKSize` must be **1–1000**; `histogramBuckets` must be non-empty, strictly ascending, and all positive. Invalid values throw descriptive errors from `normalizeMetricsConfig`.
- **`createRateLimiter`** return type now exposes `express` as `ExpressRateLimiterHandler` for metrics-related autocomplete.

### Documentation

- JSDoc expanded on metrics types, adapters (with usage examples), `Histogram`, and related APIs.

## [1.2.1] - 2026-03-31

### Fixed

- **Draft mode with grouped windows (`limits`)** — when `draft: true` and a later window blocked, only that window's increment was rolled back; earlier windows that had already been incremented are now decremented as well, so draft probes do not leak counts on looser windows.
- **Sliding-window `decrement`** — `MemoryStore` and `RedisStore` now remove the **oldest** hit (FIFO), not the newest, so `skipFailedRequests` / `skipSuccessfulRequests` align with the request that finished under concurrency.
- **Fastify middleware** — `onRequest` uses an explicit `try`/`catch` and `reply.send(err)` to match Express error handling, so failures from `keyGenerator`, the engine, or `onLimitReached` go through the same explicit path.

## [1.2.0] - 2026-03-31

### Added

- **Presets** (`singleInstancePreset`, `multiInstancePreset`, `apiGatewayPreset`, `authEndpointPreset`, `publicApiPreset`) — opinionated `Partial<RateLimitOptions>` for common deployments; `apiKeyHeaderKeyGenerator` for gateway-style API keys.
- **`createStore`**, **`CreateStoreOptions`**, **`RedisStoreConnectionOptions`** — factory for `MemoryStore` or `RedisStore` with discriminated unions (window vs token bucket; Redis `client` xor `url`).
- **`detectEnvironment`**, **`EnvironmentInfo`** — best-effort deployment hints (Kubernetes, Docker, cluster, PM2 markers) and `recommended: 'memory' | 'redis'`.
- **`warnIfMemoryStoreInCluster`** (via Express/Fastify) — one-time stderr warning when `MemoryStore` is used in a likely multi-instance environment. Suppress with `RATELIMIT_FLEX_NO_MEMORY_WARN=1` or `true`.

### Documentation

- **README** — restructured (deployment guide, presets, Redis failure handling, configuration tables, migration notes, API reference).
- **JSDoc** — expanded on public types, stores, middleware, engine, presets, `createStore`, `detectEnvironment`, and package entry exports for IntelliSense.

### Tests

- **Presets** — unit and Express integration tests.
- **Exports** — `tests/exports.test.ts` validates main and `fastify` entry exports resolve at runtime.

## [1.1.0] - 2026-03-30

### Added

- **Multiple windows per route** (`limits`): apply several independent sliding/fixed windows to the same key; a request is blocked if **any** window is exceeded. Each entry uses `{ windowMs, max }`.
- **Dynamic limits** (`maxRequests`): may be a function `(req) => number` for per-request caps (for example premium vs free tiers). Supported for window strategies via optional `increment` overrides on stores.
- **Penalty box** (`penaltyBox`): after `violationsThreshold` rate-limit blocks within `violationWindowMs`, temporarily ban the client for `penaltyDurationMs`, with optional `onPenalty` callback. Penalty state is tracked on the `RateLimitEngine` instance (in-memory).
- **Allowlist / blocklist** (`allowlist`, `blocklist`): match against the same string as `keyGenerator`; allowlist skips limiting; blocklist rejects early with `blocklistStatusCode` (default `403`) and `blocklistMessage`.
- **Draft mode** (`draft`, `onDraftViolation`): log would-be violations without blocking; increments are rolled back so production traffic is not counted while tuning limits.
- **`RateLimitStore.increment`**: optional second argument `{ maxRequests?: number }` for per-call max overrides (window strategies in `MemoryStore` and `RedisStore`).
- **`RateLimitConsumeResult`**: `draftWouldBlock` and `blockReason` (`'rate_limit' | 'blocklist' | 'penalty'`) for programmatic handling.

### Changed

- `getLimit` / `toRateLimitInfo` accept an optional request argument when `maxRequests` is a function.
- Express and Fastify middleware decrement all grouped-window stores when `skipFailedRequests` / `skipSuccessfulRequests` apply.

## [1.0.0] - 2026-03-27

### Added

- Initial public release of `ratelimit-flex`.
- Rate limiting strategies: sliding window, fixed window, and token bucket.
- Express middleware and Fastify plugin integrations.
- `MemoryStore` and Redis-backed `RedisStore`.
- TypeScript-first API with documented defaults and strategy options.
