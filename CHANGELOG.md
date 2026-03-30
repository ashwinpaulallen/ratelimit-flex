# Changelog

All notable changes to this project are documented in this file.

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
