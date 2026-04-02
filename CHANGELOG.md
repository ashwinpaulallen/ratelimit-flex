# Changelog

All notable changes to this project are documented in this file.

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

- **Draft mode with grouped windows (`limits`)** — when `draft: true` and a later window blocked, only that window’s increment was rolled back; earlier windows that had already been incremented are now decremented as well, so draft probes do not leak counts on looser windows.
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
